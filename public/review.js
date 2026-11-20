import { api, sessionForTake } from '/api.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const takeId = params.get('take');
const prodParam = params.get('prod');
let session = null;
let roomId = null;

async function init() {
  const found = await sessionForTake(takeId);
  if (found) {
    session = found.session;
    roomId = found.take.roomId;
  }
  // Owner path: a production owner without a joined seat passes ?prod= and
  // the browser-session owner token authorizes the read.
  if (!session && prodParam) {
    const ownerToken = sessionStorage.getItem(`owner:${prodParam}`);
    if (ownerToken) {
      const { ok, data } = await api('GET', `/api/takes/${takeId}`, null, ownerToken);
      if (ok) {
        session = ownerToken;
        roomId = data.take.roomId;
      }
    }
  }
  if (!session) {
    $('review-sub').textContent = 'Take unavailable — owner or room role required.';
    return;
  }
  const res = await api('GET', `/api/takes/${takeId}/replay`, null, session);
  if (!res.ok) {
    $('review-sub').textContent = `Replay unavailable: ${res.data?.message ?? 'error'}`;
    return;
  }
  render(res.data.replay);
  await initCompare();
  await initHandoff(res.data.replay);
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

// --- take comparison (FR-12) ------------------------------------------------

let roomTakes = [];

async function initCompare() {
  const { ok, data } = await api('GET', `/api/rooms/${roomId}`, null, session);
  if (!ok) return;
  roomTakes = data.takes ?? [];
  const others = roomTakes.filter((t) => t.id !== takeId);
  if (!others.length) return;
  $('compare-section').hidden = false;
  $('compare-other').replaceChildren(
    ...others.map((t) => new Option(`${t.id.slice(-6)} · ${t.status} · epoch ${t.epoch}`, t.id)),
  );
}

$('compare-btn').addEventListener('click', async () => {
  const other = $('compare-other').value;
  if (!other) return;
  const { ok, data } = await api('GET', `/api/takes/${takeId}/compare?other=${encodeURIComponent(other)}`, null, session);
  if (!ok) return;
  const tbody = document.querySelector('#compare-result tbody');
  tbody.replaceChildren();
  for (const [label, s] of [['this take', data.a], ['other take', data.b]]) {
    const tr = document.createElement('tr');
    const divText = s.firstDivergence
      ? `${s.firstDivergence.cueId} at seq ${s.firstDivergence.seq}`
      : 'none';
    for (const v of [label, s.takeId.slice(-6), s.scriptRevisionId.slice(-6), s.status, s.eventCount, divText]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.append(td);
    }
    tbody.append(tr);
  }
  $('compare-result').hidden = false;
});

// --- reviewed revision handoff (FR-11) --------------------------------------

let ownerToken = null;
let prodId = null;

async function initHandoff(replay) {
  prodId = prodParam ?? (await roomProduction());
  if (!prodId) return;
  ownerToken = sessionStorage.getItem(`owner:${prodId}`);
  if (!ownerToken) return; // desks see the review but not the owner handoff
  $('handoff-section').hidden = false;
  const res = await fetch(`/api/scripts/${replay.scriptRevisionId}/export.csv`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  if (res.ok) $('rev-csv').value = await res.text();
  const { data } = await api('GET', `/api/scripts/${replay.scriptRevisionId}`, null, ownerToken);
  if (data?.revision?.title) $('rev-title').value = `${data.revision.title} — corrected`;
}

async function roomProduction() {
  if (!roomId) return null;
  const { ok, data } = await api('GET', `/api/rooms/${roomId}`, null, session);
  return ok ? data.room.productionId : null;
}

$('rev-create').addEventListener('click', async () => {
  const csv = $('rev-csv').value;
  if (!csv.trim()) return;
  const note = $('rev-note').value.trim();
  if (!note) {
    $('rev-status').textContent = 'Record the approval note — the exported sheet must match it.';
    $('rev-status').className = 'status-line error';
    return;
  }
  const { ok, data } = await api('POST', `/api/productions/${prodId}/scripts`, {
    csv,
    title: $('rev-title').value.trim() || 'Corrected scene',
    clientRequestId: crypto.randomUUID(),
    sourceTakeId: takeId,
    approvalNote: note,
  }, ownerToken);
  if (!ok) {
    $('rev-status').textContent = data?.message ?? 'Revision rejected.';
    $('rev-status').className = 'status-line error';
    return;
  }
  $('rev-status').textContent = data.existing
    ? `Already recorded as R${data.revision.seq} — idempotent retry returned the same revision.`
    : `Created R${data.revision.seq} — ${data.revision.cues.length} cues.`;
  $('rev-status').className = 'status-line ok';
  $('rev-done').hidden = false;
  $('rev-export').dataset.rev = data.revision.id;
  $('repin-btn').dataset.rev = data.revision.id;
});

$('rev-export').addEventListener('click', async (e) => {
  e.preventDefault();
  const revId = $('rev-export').dataset.rev;
  const res = await fetch(`/api/scripts/${revId}/export.csv`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  if (!res.ok) {
    $('rev-status').textContent = 'Export denied.';
    $('rev-status').className = 'status-line error';
    return;
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${revId}-calling-sheet.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('repin-btn').addEventListener('click', async () => {
  const { ok, data } = await api('POST', `/api/rooms/${roomId}/revision`,
    { scriptRevisionId: $('repin-btn').dataset.rev }, ownerToken);
  $('repin-status').textContent = ok
    ? 'Room now starts new takes on the corrected revision. The take above is unchanged.'
    : data?.message ?? 'Could not repin.';
  $('repin-status').className = `status-line ${ok ? 'ok' : 'error'}`;
});

await init();
