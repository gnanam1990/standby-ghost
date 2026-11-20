import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeRehearsal, command } from './helpers.mjs';

// T-010: Remove optional human timing evidence; show unknown timing while
// the text view preserves the observed sequence and reasoning.
test('T-010 missing human timing shows unknown, sequence and reasoning preserved', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { sessions, take } = await makeRehearsal(app);
  const { caller, lights, sound } = sessions;
  const T = take.id;

  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1' });
  // one observation WITH desk-reported stage time, one WITHOUT
  await command(app.base, T, lights.sessionToken, {
    kind: 'OBSERVED_GO', cueId: 'L1', payload: { observation: 'fired_early', observedAt: '00:00:07.2' },
  });
  await command(app.base, T, sound.sessionToken, {
    kind: 'OBSERVED_GO', cueId: 'S1', payload: { observation: 'fired_late' },
  });

  const replay = (await api(app.base, 'GET', `/api/takes/${T}/replay`, null, caller.sessionToken)).data.replay;
  const l1 = replay.observed.find((o) => o.cueId === 'L1');
  const s1 = replay.observed.find((o) => o.cueId === 'S1');
  assert.equal(l1.observedAt, '00:00:07.2');
  assert.equal(s1.observedAt, 'unknown', 'missing human timing must surface as unknown');
  // sequence and reasoning intact regardless of timing evidence
  assert.deepEqual(replay.observed.map((o) => [o.seq, o.cueId]), [[l1.seq, 'L1'], [s1.seq, 'S1']]);
  assert.ok(replay.firstDivergence, 'L1 still diverges before S1 resolves');
  assert.deepEqual(replay.firstDivergence.violatedEdge, { from: 'S1', to: 'L1' });
  // S1's late testimony does not erase the earlier evidenced divergence
  assert.equal(replay.firstDivergence.seq, l1.seq);
});
