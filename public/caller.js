import { api } from '/api.js';

const $ = (id) => document.getElementById(id);
const takeId = new URLSearchParams(location.search).get('take');
let session = null;
let snapshot = null;
let lastSeq = 0;

import { sessionForTake } from '/api.js';

async function init() {
  const found = await sessionForTake(takeId);
  if (!found) {
    $('take-sub').textContent = 'Take unavailable or credentials required.';
    return;
  }
  session = found.session;
  if (!session) {
    $('take-sub').textContent = 'Join this room from an invitation link first.';
    return;
  }
  $('take-sub').textContent = `Take ${takeId.slice(-6)} · room ${found.take.roomId.slice(-6)}`;
  await refresh();
  setInterval(refresh, 1500);
}

async function refresh() {
  const { ok, data } = await api('GET', `/api/takes/${takeId}/snapshot`, null, session);
  if (!ok) {
    $('action-status').textContent = data?.message ?? 'Snapshot failed';
    return;
  }
  snapshot = data;
  lastSeq = data.take.nextSeq;
  renderCues();
  renderHeld();
  await renderLog();
}

async function send(kind, cueId, payload = {}) {
  const body = {
    commandId: crypto.randomUUID(),
    epoch: snapshot.take.epoch,
    expectedSeq: lastSeq,
    kind,
    payload,
  };
  if (cueId) body.cueId = cueId;
  const { status, data } = await api('POST', `/api/takes/${takeId}/commands`, body, session);
  if (status === 201 || status === 200) {
    $('action-status').textContent = `${kind}${cueId ? ' ' + cueId : ''} recorded at seq ${data.event.seq}.`;
    $('action-status').className = 'status-line ok';
  } else {
    $('action-status').textContent = `${kind} rejected: ${data?.message ?? 'error'} (${data?.error ?? status})`;
    $('action-status').className = 'status-line error';
  }
  await refresh();
}

function renderCues() {
  const tbody = document.querySelector('#cue-table tbody');
  tbody.replaceChildren();
  const held = snapshot.take.status === 'held';
  const sealed = snapshot.take.status === 'sealed';
  const disabled = held || sealed;
  for (const c of snapshot.cues) {
    const tr = document.createElement('tr');
    const cells = [
      c.id,
      c.lane,
      c.trigger === 'human' ? 'human entrance' : 'caller GO',
      c.state.state + (c.state.state === 'skipped' ? ` (${c.state.pathChoice})` : ''),
    ];
    for (const v of cells) {
      const td = document.createElement('td');
      if (v === c.lane) {
        const b = document.createElement('span');
        b.className = `badge ${c.lane}`;
        b.textContent = c.lane;
        td.append(b);
      } else td.textContent = String(v);
      tr.append(td);
    }
    const act = document.createElement('td');
    const mkBtn = (label, kind, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', () => send(kind, c.id));
      return b;
    };
    if (c.state.state === 'waiting') act.append(mkBtn('Standby', 'STANDBY', 'Announce standby for this cue'));
    if (c.state.state === 'standby') {
      if (c.trigger === 'human') act.append(mkBtn('Entrance', 'ENTRANCE', 'Record the human entrance'));
      else act.append(mkBtn('GO', 'GO', 'Call GO for this cue'));
    }
    if (c.state.state === 'acknowledged') act.append(mkBtn('GO', 'GO', 'Call GO for this cue'));
    tr.append(act);
    tbody.append(tr);
  }
  $('hold-btn').disabled = snapshot.take.status !== 'active';
  $('finish-btn').disabled = sealed;
}

function renderHeld() {
  const held = snapshot.take.status === 'held';
  $('hold-panel').hidden = !held && snapshot.take.status !== 'active';
  $('hold-panel').hidden = snapshot.take.status === 'sealed';
  $('skip-panel').hidden = !held;
  $('resume-panel').hidden = !held;
  if (!held) return;
  const runnable = snapshot.cues.filter(
    (c) => c.state.state !== 'called' && c.state.state !== 'observed',
  );
  $('skip-cue').replaceChildren(...runnable.map((c) => new Option(c.id, c.id)));
  $('resume-dest').replaceChildren(...runnable.map((c) => new Option(c.id, c.id)));
}

async function renderLog() {
  const { data } = await api('GET', `/api/takes/${takeId}/events?after=0`, null, session);
  const tbody = document.querySelector('#event-table tbody');
  tbody.replaceChildren();
  for (const e of data?.events ?? []) {
    const tr = document.createElement('tr');
    const detail = Object.entries(e.payload ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    for (const v of [e.seq, e.epoch, `${e.actorName} (${e.actorRole})`, e.kind, e.cueId ?? '—', detail]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.append(td);
    }
    tbody.append(tr);
  }
}

$('hold-btn').addEventListener('click', () => {
  $('hold-panel').hidden = false;
  $('hold-reason').focus();
});
$('hold-confirm').addEventListener('click', async () => {
  const reason = $('hold-reason').value.trim();
  if (!reason) return;
  await send('HOLD', undefined, { reason });
});
$('skip-confirm').addEventListener('click', async () => {
  await send('SKIP', $('skip-cue').value, {
    reason: $('skip-reason').value.trim(),
    path: $('skip-path').value,
  });
});
$('resume-confirm').addEventListener('click', async () => {
  await send('RESUME', undefined, {
    destination: $('resume-dest').value,
    reason: $('resume-reason').value.trim(),
  });
});
$('finish-btn').addEventListener('click', () => send('FINISH'));

await init();
