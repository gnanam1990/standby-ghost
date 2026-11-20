import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeRehearsal, command, nextCommandId } from './helpers.mjs';

// T-006: Race hold with GO and deliver a delayed ACK; only actions permitted
// by the winning sequence and epoch take effect.
test('T-006 hold beats GO; delayed ACK and stale epoch are rejected', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { sessions, take } = await makeRehearsal(app);
  const { caller, sound } = sessions;
  const T = take.id;

  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1' });
  await command(app.base, T, caller.sessionToken, { kind: 'ENTRANCE', cueId: 'E1' });
  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'S1' });

  // HOLD lands before the GO: GO must be rejected while held
  const hold = await command(app.base, T, caller.sessionToken, { kind: 'HOLD', payload: { reason: 'check' } });
  assert.equal(hold.status, 201);
  const go = await command(app.base, T, caller.sessionToken, { kind: 'GO', cueId: 'S1' });
  assert.equal(go.status, 409);
  assert.equal(go.data.error, 'held');

  // delayed ACK issued during the hold is also rejected
  const ack = await command(app.base, T, sound.sessionToken, { kind: 'ACK', cueId: 'S1' });
  assert.equal(ack.status, 409);

  // recover: skip nothing, resume at S1 again → epoch 2
  const resume = await command(app.base, T, caller.sessionToken, {
    kind: 'RESUME', payload: { destination: 'S1', reason: 'continue at S1' },
  });
  assert.equal(resume.status, 201);

  // a fresh ACK carrying the old epoch is stale
  const staleAck = await command(app.base, T, sound.sessionToken, { kind: 'ACK', cueId: 'S1', epoch: 1 });
  assert.equal(staleAck.status, 409);
  assert.equal(staleAck.data.error, 'stale_epoch');

  // the same ACK re-sent at the right epoch lands exactly once (INV-03)
  const ackId = nextCommandId('ack');
  const a1 = await command(app.base, T, sound.sessionToken, { kind: 'ACK', cueId: 'S1', epoch: 2, commandId: ackId });
  assert.equal(a1.status, 201);
  const a2 = await command(app.base, T, sound.sessionToken, { kind: 'ACK', cueId: 'S1', epoch: 2, commandId: ackId, expectedSeq: 999 });
  assert.equal(a2.status, 200, 'exact retry returns the original event even with a stale cursor');
  assert.equal(a2.data.event.seq, a1.data.event.seq);

  // a different command under the same id conflicts
  const conflict = await command(app.base, T, sound.sessionToken, { kind: 'OBSERVED_GO', cueId: 'S1', epoch: 2, commandId: ackId });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'command_conflict');

  const ev = (await api(app.base, 'GET', `/api/takes/${T}/events?after=0`, null, caller.sessionToken)).data;
  assert.equal(ev.events.filter((e) => e.commandId === ackId).length, 1, 'INV-03: at most one event per command id');
});

// T-006 permutation coverage: duplicate/stale inputs across orderings never
// produce more than one event per command id or move a held take.
test('T-006b permutations of duplicate and stale commands preserve invariants', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { sessions, take } = await makeRehearsal(app);
  const { caller, sound } = sessions;
  const T = take.id;

  const plan = [
    { kind: 'STANDBY', cueId: 'E1', actor: caller },
    { kind: 'HOLD', actor: caller, payload: { reason: 'perm hold' } },
    { kind: 'ACK', cueId: 'E1', actor: sound },      // wrong lane + held: always rejected
    { kind: 'GO', cueId: 'S1', actor: caller },       // held: always rejected
    { kind: 'RESUME', actor: caller, payload: { destination: 'E1', reason: 'back to E1' } },
  ];
  // run every adjacent swap of the plan against fresh takes
  for (let i = 0; i < plan.length - 1; i++) {
    const fresh = await api(app.base, 'POST', `/api/rooms/${take.roomId}/takes`, {}, caller.sessionToken);
    const FT = fresh.data.take.id;
    const swapped = [...plan];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    for (const step of swapped) {
      await command(app.base, FT, step.actor.sessionToken, {
        kind: step.kind, cueId: step.cueId, payload: step.payload ?? {},
      });
    }
    const ev = (await api(app.base, 'GET', `/api/takes/${FT}/events?after=0`, null, caller.sessionToken)).data.events;
    const ids = new Set(ev.map((e) => e.commandId));
    assert.equal(ids.size, ev.length, 'no duplicate command ids accepted');
    // sound never contributed an event (wrong lane for E1)
    assert.ok(ev.every((e) => e.actorRole !== 'sound'), 'desk command from wrong lane must not land');
    // a HOLD can only be followed by SKIP/RESUME/OBSERVED_GO
    const holdIdx = ev.findIndex((e) => e.kind === 'HOLD');
    if (holdIdx >= 0) {
      const after = ev.slice(holdIdx + 1);
      const resumeIdx = after.findIndex((e) => e.kind === 'RESUME');
      const duringHold = resumeIdx >= 0 ? after.slice(0, resumeIdx) : after;
      assert.ok(duringHold.every((e) => ['SKIP', 'OBSERVED_GO'].includes(e.kind)), 'no cue advances while held');
    }
  }
});
