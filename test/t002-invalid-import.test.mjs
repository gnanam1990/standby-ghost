import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeProduction, FIXTURE_CSV } from './helpers.mjs';

const HEADER = 'cue_id,lane,label,after,trigger';

// T-002: Submit a cycle or unknown predecessor; reject the import with row
// details and retain the previous draft.
test('T-002 invalid imports are rejected with row details; previous draft retained', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const prod = await makeProduction(app.base);

  const good = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: FIXTURE_CSV, title: 'R1',
  }, prod.ownerToken);
  assert.equal(good.status, 201);

  const cyclic = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: `${HEADER}\nA,sound,a,B,caller\nB,sound,b,A,caller\n`, title: 'cycle',
  }, prod.ownerToken);
  assert.equal(cyclic.status, 422);
  assert.equal(cyclic.data.error, 'script_rejected');
  assert.ok(cyclic.data.details.errors.some((e) => /cycle/.test(e.message) && e.row >= 2));

  const unknown = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: `${HEADER}\nA,sound,a,GHOST,caller\n`, title: 'unknown dep',
  }, prod.ownerToken);
  assert.equal(unknown.status, 422);
  const err = unknown.data.details.errors[0];
  assert.equal(err.row, 2);
  assert.match(err.message, /unknown predecessor/);

  // previous draft retained: still exactly one revision
  const list = await api(app.base, 'GET', `/api/productions/${prod.id}`);
  assert.equal(list.data.revisions.length, 1);
  assert.equal(list.data.revisions[0].id, good.data.revision.id);
});

test('import requires owner credentials', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const prod = await makeProduction(app.base);
  const anon = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: FIXTURE_CSV, title: 'anon',
  });
  assert.equal(anon.status, 403);
  const bad = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: FIXTURE_CSV, title: 'bad',
  }, 'wrong-token');
  assert.equal(bad.status, 403);
});
