import { api } from '/api.js';
import { outboxDecision, loadOutbox, saveOutbox, upsert } from '/outbox.js';

const $ = (id) => document.getElementById(id);
const takeId = new URLSearchParams(location.search).get('take');
let session = null;
let me = null;
let snapshot = null;
let ws = null;
let online = false;
let lastSeq = 0;
const outboxKey = `sg-outbox:${takeId}`;
let outbox = loadOutbox(localStorage, outboxKey);

function save() {
  saveOutbox(localStorage, outboxKey, outbox);
}

async function init() {
  const { ok, data } = await api('GET', `/api/takes/${takeId}`);
  if (!ok) {
    $('desk-sub').textContent = `Take unavailable: ${data?.message ?? 'error'}`;
    return;
  }
  session = localStorage.getItem(`sg-session:${data.take.roomId}`);
  me = JSON.parse(localStorage.getItem(`sg-member:${data.take.roomId}`) ?? 'null');
  if (!session || !me) {
    $('desk-sub').textContent = 'Join this room from an invitation link first.';
    return;
  }
  $('desk-role').textContent = `${me.role} desk`;
  $('desk-sub').textContent = `${me.name} · generation ${me.generation}`;
  connect();
  await refresh();
  renderOutbox();
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?session=${session}`);
  ws.addEventListener('open', async () => {
    online = true;
    $('conn').textContent = 'connected';
    ws.send(JSON.stringify({ type: 'subscribe', takeId, after: lastSeq }));
    await refresh();
    flushOutbox();
  });
  ws.addEventListener('message', async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'event' && msg.takeId === takeId) {
      lastSeq = Math.max(lastSeq, msg.event.seq);
      await refresh();
    } else if (msg.type === 'events' && msg.takeId === takeId) {
      for (const e of msg.events) lastSeq = Math.max(lastSeq, e.seq);
      await refresh();
    }
  });
  ws.addEventListener('close', () => {
    online = false;
    $('conn').textContent = 'offline — actions queue locally';
    setTimeout(connect, 1500);
  });
  ws.addEventListener('error', () => ws.close());
}

async function refresh() {
  const { ok, data } = await api('GET', `/api/takes/${takeId}/snapshot`, null, session);
  if (!ok) {
    $('ack-status').textContent = data?.message ?? 'snapshot failed';
    return;
  }
  snapshot = data;
  renderAck();
  renderReportCues();
  await renderLog();
  renderOutbox();
}

/** Current standby in my lane (there is at most one actionable per lane). */
function myStandby() {
  return snapshot?.cues.find((c) => c.lane === me.role && c.state.state === 'standby');
}

function renderAck() {
  const c = myStandby();
  $('standby-line').textContent = c
    ? `Standby: ${c.id} — ${c.label}`
    : 'No standby in your lane.';
  const sealed = snapshot?.take.status === 'sealed';
  $('ack-btn').disabled = !c || !online || sealed;
  $('ack-btn').textContent = c ? `Acknowledge standby ${c.id}` : 'Acknowledge standby';
}

function renderReportCues() {
  const sel = $('report-cue');
  const mine = (snapshot?.cues ?? []).filter((c) => c.lane === me.role);
  const keep = sel.value;
  sel.replaceChildren(...mine.map((c) => new Option(`${c.id} — ${c.label}`, c.id)));
  if (keep) sel.value = keep;
  $('report-btn').disabled = !mine.length || !online;
}

async function postCommand(kind, cueId, payload) {
  const entry = {
    commandId: crypto.randomUUID(),
    takeId,
    epoch: snapshot.take.epoch,
    kind,
    cueId,
    payload,
    state: 'pending',
    detail: '',
  };
  outbox = upsert(outbox, entry);
  save();
  renderOutbox();
  if (online) await sendEntry(entry);
}

async function sendEntry(entry) {
  const decision = outboxDecision(entry, { takeId, epoch: snapshot.take.epoch });
  if (decision === 'reconfirm') {
    entry.state = 'reconfirm';
    entry.detail = 'take or epoch changed — confirm before resending';
    save();
    renderOutbox();
    return;
  }
  entry.state = 'sending';
  renderOutbox();
  const body = {
    commandId: entry.commandId,
    epoch: snapshot.take.epoch,
    kind: entry.kind,
    cueId: entry.cueId,
    payload: entry.payload,
  };
  try {
    const { status, data } = await api('POST', `/api/takes/${takeId}/commands`, body, session);
    if (status === 200 || status === 201) {
      entry.state = 'accepted';
      entry.detail = `seq ${data.event.seq}`;
    } else {
      entry.state = 'rejected';
      entry.detail = `${data?.error ?? status}: ${data?.message ?? ''}`;
    }
  } catch {
    entry.state = 'pending';
    entry.detail = 'send failed — still queued';
  }
  save();
  renderOutbox();
  await refresh();
}

async function flushOutbox() {
  for (const entry of [...outbox]) {
    const decision = outboxDecision(entry, { takeId, epoch: snapshot?.take.epoch });
    if (decision === 'send') await sendEntry(entry);
    else if (decision === 'reconfirm' && entry.state !== 'reconfirm') {
      entry.state = 'reconfirm';
      entry.detail = 'take or epoch changed — confirm before resending';
      save();
    }
  }
  renderOutbox();
}

function renderOutbox() {
  const list = $('outbox-list');
  list.replaceChildren();
  if (!outbox.length) {
    const li = document.createElement('li');
    li.textContent = 'Empty — actions appear here with their delivery state.';
    list.append(li);
    return;
  }
  for (const e of outbox) {
    const li = document.createElement('li');
    const label = `${e.kind}${e.cueId ? ' ' + e.cueId : ''} — ${e.state}${e.detail ? ` (${e.detail})` : ''}`;
    li.textContent = label;
    if (e.state === 'reconfirm') {
      const btn = document.createElement('button');
      btn.textContent = 'Reconfirm & send';
      btn.addEventListener('click', async () => {
        e.state = 'pending';
        e.epoch = snapshot.take.epoch;
        e.takeId = takeId;
        save();
        await sendEntry(e);
      });
      li.append(' ', btn);
    }
    list.append(li);
  }
}

async function renderLog() {
  const { data } = await api('GET', `/api/takes/${takeId}/events?after=0`, null, session);
  const tbody = document.querySelector('#event-table tbody');
  tbody.replaceChildren();
  for (const e of data?.events ?? []) {
    const tr = document.createElement('tr');
    for (const v of [e.seq, e.epoch, `${e.actorName} (${e.actorRole})`, e.kind, e.cueId ?? '—']) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.append(td);
    }
    tbody.append(tr);
  }
}

$('ack-btn').addEventListener('click', () => {
  const c = myStandby();
  if (c) postCommand('ACK', c.id, { note: 'desk ready' });
});

$('report-btn').addEventListener('click', () => {
  const cueId = $('report-cue').value;
  if (!cueId) return;
  postCommand('OBSERVED_GO', cueId, {
    observation: $('report-obs').value,
    reason: $('report-reason').value.trim(),
  });
});

await init();
