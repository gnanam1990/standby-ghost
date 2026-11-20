import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeRehearsal, FIXTURE_CSV } from './helpers.mjs';

// T-012: a revision request repeated after a timeout creates exactly one
// revision, and its exported rows still match the recorded approval.
test('T-012 repeated revision request is idempotent; export matches approval', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { prod, take } = await makeRehearsal(app);

  const corrected = FIXTURE_CSV.replace('L1,lights,Warm front light up,S1,caller',
    'L1,lights,Warm front light up,E1,caller');
  const body = {
    csv: corrected,
    title: 'The returning letter — corrected',
    clientRequestId: 'req-timeout-retry-7',
    sourceTakeId: take.id,
    approvalNote: 'SM approved: L1 follows the entrance directly',
  };

  const first = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, body, prod.ownerToken);
  assert.equal(first.status, 201);
  assert.equal(first.data.existing, false);

  // simulate the client timing out after the server committed, then retrying
  const retry = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, body, prod.ownerToken);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.existing, true);
  assert.equal(retry.data.revision.id, first.data.revision.id);

  // exactly one revision was created for that request id
  const listing = await api(app.base, 'GET', `/api/productions/${prod.id}`, null, prod.ownerToken);
  assert.equal(listing.data.revisions.length, 2); // original + corrected

  // exported rows still match the recorded approval metadata
  const rev = (await api(app.base, 'GET',
    `/api/scripts/${first.data.revision.id}`, null, prod.ownerToken)).data.revision;
  assert.equal(rev.approvalNote, body.approvalNote);
  assert.equal(rev.sourceTakeId, take.id);
  const csvRes = await fetch(`${app.base}/api/scripts/${rev.id}/export.csv`, {
    headers: { authorization: `Bearer ${prod.ownerToken}` },
  });
  const csv = await csvRes.text();
  assert.match(csv, /L1,lights,Warm front light up,E1,caller/);
  assert.equal(rev.cues.find((c) => c.id === 'L1').deps.join(','), 'E1');

  // sourceTakeId must be a take in the same production
  const bad = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    ...body, clientRequestId: 'other-req', sourceTakeId: 'take_nonexistent',
  }, prod.ownerToken);
  assert.equal(bad.status, 422);
});
