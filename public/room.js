import { api } from '/api.js';

const $ = (id) => document.getElementById(id);
const roomId = new URLSearchParams(location.search).get('room');
const session = localStorage.getItem(`sg-session:${roomId}`);
const origin = location.origin;
let ownerToken = null; // resolved after first fetch via room.productionId

let lastRosterJson = '';

async function refresh() {
  const { ok, data } = await api('GET', `/api/rooms/${roomId}`, null, session);
  if (!ok) {
    $('room-sub').textContent = `Room unavailable: ${data?.message ?? 'error'}`;
    return;
  }
  ownerToken = sessionStorage.getItem(`owner:${data.room.productionId}`);
  $('room-sub').textContent = `${data.room.name} · revision R${data.scriptRevision.seq} "${data.scriptRevision.title}"`;

  $('me-line').textContent = data.me
    ? `${data.me.name} — ${data.me.role} (generation ${data.me.generation})`
    : 'Not joined on this browser. Use an invitation link to take a seat.';

  const rosterJson = JSON.stringify(data.roster);
  if (rosterJson !== lastRosterJson) {
    lastRosterJson = rosterJson;
    renderRoster(data.roster);
  }
  renderTakes(data.takes);

  const isOwner = !!ownerToken;
  $('invite-panel').hidden = !isOwner;
  document.querySelectorAll('.owner-only').forEach((el) => {
    el.hidden = !isOwner;
  });
  $('take-start').hidden = !(data.me?.role === 'caller');
}

function renderRoster(roster) {
  const tbody = document.querySelector('#roster-table tbody');
  tbody.replaceChildren();
  for (const m of roster.members) {
    const tr = document.createElement('tr');
    for (const v of [m.name, m.role, m.generation, m.status]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.append(td);
    }
    const act = document.createElement('td');
    act.className = 'owner-only';
    act.hidden = !ownerToken;
    if (m.status === 'active' && ownerToken) {
      const btn = document.createElement('button');
      btn.className = 'danger';
      btn.textContent = `Revoke ${m.role}`;
      btn.addEventListener('click', async () => {
        await api('POST', `/api/rooms/${roomId}/members/${m.id}/revoke`, {}, ownerToken);
        await refresh();
      });
      act.append(btn);
    }
    tr.append(act);
    tbody.append(tr);
  }
  const list = $('invite-list');
  list.replaceChildren();
  for (const inv of roster.openInvitations) {
    const li = document.createElement('li');
    li.textContent = `${inv.role} for ${inv.name ?? 'anyone'} · expires ${inv.expiresAt}`;
    list.append(li);
  }
  if (!roster.openInvitations.length) {
    const li = document.createElement('li');
    li.textContent = 'None.';
    list.append(li);
  }
}

function renderTakes(takes) {
  const list = $('take-list');
  list.replaceChildren();
  for (const t of takes) {
    const li = document.createElement('li');
    li.textContent = `Take ${t.id.slice(-6)} · ${t.status} · epoch ${t.epoch} · seq ${t.nextSeq - 1}`;
    list.append(li);
  }
  if (!takes.length) {
    const li = document.createElement('li');
    li.textContent = 'No takes yet.';
    list.append(li);
  }
}

$('inv-create').addEventListener('click', async () => {
  const { ok, data } = await api('POST', `/api/rooms/${roomId}/invitations`, {
    role: $('inv-role').value,
    name: $('inv-name').value.trim(),
    ttlMinutes: Number($('inv-ttl').value) || 60,
  }, ownerToken);
  if (!ok) {
    $('inv-status').textContent = data?.message ?? 'Failed.';
    return;
  }
  const url = `${origin}${data.joinUrl}`;
  await navigator.clipboard?.writeText(url).catch(() => {});
  $('inv-status').textContent = `${data.invitation.role} link (expires ${data.invitation.expiresAt}): ${url}`;
  await refresh();
});

$('take-start').addEventListener('click', async () => {
  const { ok, data } = await api('POST', `/api/rooms/${roomId}/takes`, {}, session);
  $('take-status').textContent = ok
    ? `Take ${data.take.id.slice(-6)} started at epoch ${data.take.epoch}.`
    : data?.message ?? 'Could not start take.';
  await refresh();
});

await refresh();
setInterval(refresh, 2000);
