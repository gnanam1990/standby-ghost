import { api, sessionForTake } from '/api.js';

const $ = (id) => document.getElementById(id);
const takeId = new URLSearchParams(location.search).get('take');
let session = null;

async function init() {
  const found = await sessionForTake(takeId);
  if (!found) {
    $('review-sub').textContent = 'Take unavailable — owner or room role required.';
    return;
  }
  session = found.session;
  const res = await api('GET', `/api/takes/${takeId}/replay`, null, session);
  if (!res.ok) {
    $('review-sub').textContent = `Replay unavailable: ${res.data?.message ?? 'error'}`;
    return;
  }
  render(res.data.replay);
}

function render(replay) {
  $('review-sub').textContent =
    `Take ${replay.takeId.slice(-6)} · ${replay.status} · epoch ${replay.epoch}`;
  renderTimeline(replay);
  renderTable(replay);
  renderDivergence(replay);
  renderUnresolved(replay);
}

const W = 720, ROW = 56, PAD = 30;

function renderTimeline(replay) {
  const n = replay.expectedOrder.length;
  const h = ROW * 2 + PAD * 2;
  const x = (i) => PAD + (n <= 1 ? 0 : (i * (W - 2 * PAD)) / Math.max(1, n - 1));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${h}`);
  svg.setAttribute('width', '100%');

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `<pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="#e06c5c"/><line x1="0" y1="0" x2="0" y2="6" stroke="#14161a" stroke-width="2"/></pattern>`;
  svg.append(defs);

  const mkLine = (y, dash) => {
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', PAD); l.setAttribute('x2', W - PAD);
    l.setAttribute('y1', y); l.setAttribute('y2', y);
    l.setAttribute('stroke', '#9aa0a8');
    if (dash) l.setAttribute('stroke-dasharray', '6 5');
    l.setAttribute('stroke-width', '2');
    svg.append(l);
  };
  mkLine(PAD + 20, true);          // planned (dashed)
  mkLine(PAD + ROW + 20, false);   // actual (solid)

  const label = (xPos, y, text, anchor = 'middle') => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', xPos); t.setAttribute('y', y);
    t.setAttribute('text-anchor', anchor);
    t.setAttribute('fill', '#9aa0a8'); t.setAttribute('font-size', '11');
    t.textContent = text;
    svg.append(t);
  };
  label(PAD, PAD + 14, 'planned', 'start');
  label(PAD, PAD + ROW + 14, 'actual', 'start');

  const obsByCue = new Map();
  for (const o of replay.observed) {
    if (!obsByCue.has(o.cueId)) obsByCue.set(o.cueId, o);
  }
  const div = replay.firstDivergence;

  replay.expectedOrder.forEach((cueId, i) => {
    // planned node (hollow)
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', x(i)); c.setAttribute('cy', PAD + 20); c.setAttribute('r', 7);
    c.setAttribute('fill', '#1d2127'); c.setAttribute('stroke', '#9aa0a8');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `planned ${cueId}`;
    c.append(title);
    svg.append(c);
    label(x(i), PAD + 44, cueId);
  });

  // actual nodes ordered by observed seq position on their cue's x slot
  for (const [cueId, o] of obsByCue) {
    const idx = replay.expectedOrder.indexOf(cueId);
    if (idx < 0) continue;
    const isDiv = div && div.cueId === cueId;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', x(idx)); c.setAttribute('cy', PAD + ROW + 20); c.setAttribute('r', 7);
    c.setAttribute('fill', isDiv ? 'url(#hatch)' : '#6fbf73');
    c.setAttribute('stroke', isDiv ? '#e06c5c' : '#6fbf73');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${cueId} recorded at seq ${o.seq}${isDiv ? ' — first divergence' : ''}`;
    c.append(title);
    svg.append(c);
    label(x(idx), PAD + ROW + 44, `${cueId}·${o.seq}`);
  }
  $('timeline').replaceChildren(svg);
}

function renderTable(replay) {
  const tbody = document.querySelector('#compare-table tbody');
  tbody.replaceChildren();
  const obsByCue = new Map();
  for (const o of replay.observed) {
    if (!obsByCue.has(o.cueId)) obsByCue.set(o.cueId, []);
    obsByCue.get(o.cueId).push(o);
  }
  const div = replay.firstDivergence;
  replay.expectedOrder.forEach((cueId, i) => {
    const obs = obsByCue.get(cueId) ?? [];
    const lane = replay.lanes[cueId] ?? '';
    const tr = document.createElement('tr');
    const isDiv = div && div.cueId === cueId;
    if (isDiv) tr.style.outline = '2px solid var(--bad)';
    const note = isDiv
      ? `FIRST DIVERGENCE — ${div.explanation}`
      : obs.length
        ? `${obs.length} recorded observation(s)`
        : 'not observed';
    for (const v of [cueId, lane, i + 1, obs.map((o) => o.seq).join(', ') || '—', note]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.append(td);
    }
    if (isDiv) {
      tr.tabIndex = 0;
      tr.setAttribute('aria-label', `first divergence: ${div.explanation}`);
    }
    tbody.append(tr);
  });
}

function renderDivergence(replay) {
  const div = replay.firstDivergence;
  if (!div) {
    $('divergence-text').textContent =
      'No divergence: every recorded execution respected the planned dependency order.';
    $('divergence-gaps').replaceChildren();
    $('table-divergence').textContent = 'No divergence recorded.';
    return;
  }
  $('divergence-text').textContent = div.explanation;
  $('divergence-gaps').replaceChildren();
  for (const g of div.observationGaps) {
    const li = document.createElement('li');
    li.textContent = g;
    $('divergence-gaps').append(li);
  }
  // the table identifies the same divergence in words (NFR-02)
  $('table-divergence').textContent = `First divergence: ${div.explanation}`;
}

function renderUnresolved(replay) {
  const list = $('unresolved-list');
  list.replaceChildren();
  if (!replay.unresolved.length) {
    const li = document.createElement('li');
    li.textContent = 'None — every intent has a recorded outcome.';
    list.append(li);
    return;
  }
  for (const u of replay.unresolved) {
    const li = document.createElement('li');
    li.textContent = `${u.cueId} (${u.lane}): ${u.detail}`;
    list.append(li);
  }
}

await init();
