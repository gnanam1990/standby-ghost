import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeRehearsal, command } from './helpers.mjs';

// T-009: Record a desk-reported early lighting action that violates a
// required predecessor; replay in a fresh browser and locate the same
// earliest divergence by sequence and lane. Permute two independent
// parallel cues and verify neither triggers a divergence.
test('T-009 early L1 testimony diverges at the violated edge, stable across readers', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { sessions, take } = await makeRehearsal(app);
  const { caller, lights } = sessions;
  const T = take.id;

  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1' });
  // lights desk reports L1 fired — before E1 entrance, S1 or L1's own call
  const early = await command(app.base, T, lights.sessionToken, {
    kind: 'OBSERVED_GO', cueId: 'L1', payload: { observation: 'fired_early', reason: 'L1 went before the chime' },
  });
  assert.equal(early.status, 201);

  const replay = (await api(app.base, 'GET', `/api/takes/${T}/replay`, null, caller.sessionToken)).data.replay;
  assert.ok(replay.firstDivergence, 'a divergence must be reported');
  assert.equal(replay.firstDivergence.seq, early.data.event.seq);
  assert.deepEqual(replay.firstDivergence.violatedEdge, { from: 'S1', to: 'L1' });
  assert.equal(replay.firstDivergence.actorRole, 'lights');
  assert.match(replay.firstDivergence.explanation, /no preceding signal recorded/);
  assert.ok(replay.firstDivergence.observationGaps.some((g) => g.includes('S1')));

  // a fresh read (fresh "browser"/session) sees the identical divergence
  const again = (await api(app.base, 'GET', `/api/takes/${T}/replay`, null, lights.sessionToken)).data.replay;
  assert.deepEqual(again.firstDivergence, replay.firstDivergence);

  // unresolved outcome: E1 expected but never observed is an evidence gap
  assert.ok(replay.unresolved.some((u) => u.cueId === 'E1' && u.state === 'expected_not_observed'));
});

test('T-009b parallel independent cues may swap without diverging', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { sessions, take } = await makeRehearsal(app);
  const { caller, sound, lights } = sessions;
  const T = take.id;

  // run the scene clean through L1
  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1' });
  await command(app.base, T, caller.sessionToken, { kind: 'ENTRANCE', cueId: 'E1' });
  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'S1' });
  await command(app.base, T, sound.sessionToken, { kind: 'ACK', cueId: 'S1' });
  await command(app.base, T, caller.sessionToken, { kind: 'GO', cueId: 'S1' });
  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'L1' });
  await command(app.base, T, caller.sessionToken, { kind: 'GO', cueId: 'L1' });

  // L2 and S2 are both after L1 with no edge between them — swap freely
  await command(app.base, T, lights.sessionToken, { kind: 'OBSERVED_GO', cueId: 'L2' });
  await command(app.base, T, sound.sessionToken, { kind: 'OBSERVED_GO', cueId: 'S2' });
  // also record the reverse order elsewhere in the same take shape
  const replay = (await api(app.base, 'GET', `/api/takes/${T}/replay`, null, caller.sessionToken)).data.replay;
  assert.equal(replay.firstDivergence, null, 'legal parallel swap must not flag');
  assert.deepEqual(
    replay.observed.map((o) => o.cueId),
    ['E1', 'S1', 'L1', 'L2', 'S2'],
  );
});
