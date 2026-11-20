import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeRehearsal, command, FIXTURE_CSV } from './helpers.mjs';

// T-011: complete a take, derive a corrected revision from its review, repin
// the room and run a second take on it — the sealed first take still points
// at its original revision (INV: edited sheets never rewrite sealed takes).
test('T-011 reviewed revision drives take 2; take 1 reopens unchanged', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { prod, room, sessions, take } = await makeRehearsal(app);
  const { caller, lights } = sessions;
  const T1 = take.id;
  const rev1 = take.scriptRevisionId;

  // take 1: entrance, then lights testifies L1 fired before S1 — a divergence
  await command(app.base, T1, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1' });
  await command(app.base, T1, caller.sessionToken, { kind: 'ENTRANCE', cueId: 'E1' });
  await command(app.base, T1, caller.sessionToken, { kind: 'STANDBY', cueId: 'S1' });
  await command(app.base, T1, lights.sessionToken, { kind: 'OBSERVED_GO', cueId: 'L1' });
  const fin = await command(app.base, T1, caller.sessionToken, { kind: 'FINISH' });
  assert.equal(fin.status, 201);

  // owner reviews and cuts the corrected revision: L1 now depends on E1
  const corrected = FIXTURE_CSV.replace('L1,lights,Warm front light up,S1,caller',
    'L1,lights,Warm front light up,E1,caller');
  const revRes = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: corrected,
    title: 'The returning letter — corrected',
    clientRequestId: 'rev-handoff-1',
    sourceTakeId: T1,
    approvalNote: 'SM approved: L1 follows the entrance directly',
  }, prod.ownerToken);
  assert.equal(revRes.status, 201);
  const rev2 = revRes.data.revision.id;
  assert.equal(revRes.data.revision.sourceTakeId, T1);
  assert.equal(revRes.data.revision.approvalNote, 'SM approved: L1 follows the entrance directly');
  assert.notEqual(rev2, rev1);

  // repin the room; take 2 pins the corrected revision
  const repin = await api(app.base, 'POST', `/api/rooms/${room.id}/revision`,
    { scriptRevisionId: rev2 }, prod.ownerToken);
  assert.equal(repin.status, 200);
  const t2 = await api(app.base, 'POST', `/api/rooms/${room.id}/takes`, {}, caller.sessionToken);
  assert.equal(t2.status, 201);
  assert.equal(t2.data.take.scriptRevisionId, rev2);

  // take 1 reopens unchanged: still sealed, still pinned to rev1
  const t1 = await api(app.base, 'GET', `/api/takes/${T1}`, null, caller.sessionToken);
  assert.equal(t1.data.take.status, 'sealed');
  assert.equal(t1.data.take.scriptRevisionId, rev1);

  // the corrected sheet exports with the changed dep
  const csvRes = await fetch(`${app.base}/api/scripts/${rev2}/export.csv`, {
    headers: { authorization: `Bearer ${prod.ownerToken}` },
  });
  assert.equal(csvRes.status, 200);
  const csv = await csvRes.text();
  assert.match(csv, /L1,lights,Warm front light up,E1,caller/);

  // the corrected take lets L1 run right after the entrance — no divergence
  const T2 = t2.data.take.id;
  await command(app.base, T2, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1' });
  await command(app.base, T2, caller.sessionToken, { kind: 'ENTRANCE', cueId: 'E1' });
  await command(app.base, T2, caller.sessionToken, { kind: 'STANDBY', cueId: 'L1' });
  await command(app.base, T2, caller.sessionToken, { kind: 'GO', cueId: 'L1' });

  // compare: take 1 shows the L1 divergence; take 2 shows none
  const cmp = await api(app.base, 'GET', `/api/takes/${T1}/compare?other=${T2}`, null, caller.sessionToken);
  assert.equal(cmp.status, 200);
  assert.equal(cmp.data.a.scriptRevisionId, rev1);
  assert.equal(cmp.data.b.scriptRevisionId, rev2);
  assert.equal(cmp.data.a.firstDivergence.cueId, 'L1');
  assert.equal(cmp.data.a.firstDivergence.violatedEdge.from, 'S1');
  assert.equal(cmp.data.b.firstDivergence, null);

  // compare rejects takes from other rooms
  const other = await makeRehearsal(app);
  const bad = await api(app.base, 'GET', `/api/takes/${T1}/compare?other=${other.take.id}`,
    null, caller.sessionToken);
  assert.equal(bad.status, 422);
});
