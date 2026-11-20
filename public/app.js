import { api } from '/api.js';

const $ = (id) => document.getElementById(id);
const state = { production: null, ownerToken: null };

function setStatus(el, msg, cls) {
  el.textContent = msg || '';
  el.className = `status-line ${cls || ''}`;
}

async function loadProductions() {
  const { data } = await api('GET', '/api/productions');
  const list = $('prod-list');
  list.replaceChildren();
  for (const p of data?.productions ?? []) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = `Open ${p.name}`;
    btn.addEventListener('click', () => openProduction(p));
    li.append(`${p.name} `, btn);
    list.append(li);
  }
}

async function openProduction(p) {
  state.production = p;
  state.ownerToken = sessionStorage.getItem(`owner:${p.id}`);
  $('import-prod-name').textContent = p.name;
  $('import-section').hidden = false;
  $('preview-section').hidden = true;
  await loadRevisions();
}

async function loadRevisions() {
  const { data } = await api('GET', `/api/productions/${state.production.id}`);
  const list = $('rev-list');
  list.replaceChildren();
  for (const r of data?.revisions ?? []) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = 'Preview calling order';
    btn.addEventListener('click', () => previewRevision(r.id));
    li.append(
      `R${r.seq} · ${r.title} · ${r.cueCount} cues · digest ${r.digest.slice(0, 12)}… `,
      btn,
    );
    list.append(li);
  }
  if (!(data?.revisions ?? []).length) {
    const li = document.createElement('li');
    li.textContent = 'No script revisions yet. Import the authorized scene CSV below.';
    list.append(li);
  }
}

async function previewRevision(id) {
  const { data } = await api('GET', `/api/scripts/${id}`);
  if (!data) return;
  const rev = data.revision;
  $('preview-section').hidden = false;
  $('preview-meta').textContent =
    `Revision R${rev.seq} "${rev.title}" · ${rev.cues.length} cues · digest ${rev.digest}`;
  const tbody = document.querySelector('#preview-table tbody');
  tbody.replaceChildren();
  const byId = new Map(rev.cues.map((c) => [c.id, c]));
  rev.callingOrder.forEach((cueId, i) => {
    const c = byId.get(cueId);
    const tr = document.createElement('tr');
    const cells = [i + 1, c.id, c.lane, c.trigger, c.deps.join(', ') || '—', c.label];
    for (const v of cells) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.append(td);
    }
    tbody.append(tr);
  });
  $('export-link').href = `/api/scripts/${id}/export.csv`;
  $('sheet-link').href = `/sheet.html?rev=${encodeURIComponent(id)}`;
  $('room-create').dataset.rev = id;
  $('preview-section').scrollIntoView({ block: 'nearest' });
}

$('prod-create').addEventListener('click', async () => {
  const name = $('prod-name').value.trim();
  if (!name) return setStatus($('prod-status'), 'Name the production first.', 'error');
  const { ok, data } = await api('POST', '/api/productions', { name });
  if (!ok) return setStatus($('prod-status'), data?.message ?? 'Failed to create.', 'error');
  sessionStorage.setItem(`owner:${data.id}`, data.ownerToken);
  setStatus($('prod-status'), `Created ${data.name}. Owner token stored for this browser session only.`, 'ok');
  $('prod-name').value = '';
  $('room-create').addEventListener('click', async () => {
  const revId = $('room-create').dataset.rev;
  const { ok, data } = await api(
    'POST',
    `/api/productions/${state.production.id}/rooms`,
    { scriptRevisionId: revId, name: 'Rehearsal room' },
    state.ownerToken,
  );
  if (!ok) {
    $('room-status').textContent = data?.message ?? 'Could not create room.';
    $('room-status').classList.add('error');
    return;
  }
  $('room-status').innerHTML = '';
  const a = document.createElement('a');
  a.href = `/room.html?room=${encodeURIComponent(data.room.id)}`;
  a.textContent = `Open rehearsal room ${data.room.id.slice(-6)}`;
  $('room-status').append('Room ready — ', a);
  $('room-status').classList.add('ok');
});

await loadProductions();
});

$('csv-import').addEventListener('click', async () => {
  $('csv-errors').replaceChildren();
  const file = $('csv-file').files[0];
  let csv = $('csv-text').value;
  if (file) csv = await file.text();
  if (!csv.trim()) return setStatus($('csv-status'), 'Choose a CSV file or paste CSV text.', 'error');
  const { ok, data } = await api(
    'POST',
    `/api/productions/${state.production.id}/scripts`,
    { csv, title: $('csv-title').value.trim() || 'Untitled scene' },
    state.ownerToken,
  );
  if (!ok) {
    setStatus($('csv-status'), data?.message ?? 'Import rejected.', 'error');
    for (const e of data?.details?.errors ?? []) {
      const li = document.createElement('li');
      li.textContent = `row ${e.row} · ${e.field}: ${e.message}`;
      $('csv-errors').append(li);
    }
    return;
  }
  setStatus($('csv-status'), `Imported R${data.revision.seq} — ${data.revision.cues.length} cues.`, 'ok');
  $('csv-text').value = '';
  $('csv-file').value = '';
  await loadRevisions();
  await previewRevision(data.revision.id);
});

$('room-create').addEventListener('click', async () => {
  const revId = $('room-create').dataset.rev;
  const { ok, data } = await api(
    'POST',
    `/api/productions/${state.production.id}/rooms`,
    { scriptRevisionId: revId, name: 'Rehearsal room' },
    state.ownerToken,
  );
  if (!ok) {
    $('room-status').textContent = data?.message ?? 'Could not create room.';
    $('room-status').classList.add('error');
    return;
  }
  $('room-status').innerHTML = '';
  const a = document.createElement('a');
  a.href = `/room.html?room=${encodeURIComponent(data.room.id)}`;
  a.textContent = `Open rehearsal room ${data.room.id.slice(-6)}`;
  $('room-status').append('Room ready — ', a);
  $('room-status').classList.add('ok');
});

await loadProductions();
