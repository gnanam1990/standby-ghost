import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeRehearsal, command, nextCommandId } from './helpers.mjs';

// T-005: Have the caller hold after a missed entrance, explicitly skip the
// blocking cue and resume at the agreed point; inspect the persisted sequence.
test('T-005 hold after missed entrance, skip E1, resume at S1 — persisted sequence', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { sessions, take } = await makeRehearsal(app);
  const { caller, sound, lights } = sessions;
  const T = take.id;

  // caller declares the expected entrance
  let r = await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1', expectedSeq: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.data.event.seq, 1);

  // the entrance never comes; the lights desk reports L1 fired early
  // (testimony only — the playhead must not move)
  r = await command(app.base, T, lights.sessionToken, { kind: 'OBSERVED_GO', cueId: 'L1', payload: { observation: 'fired', reason: 'L1 went early' } });
  assert.equal(r.status, 201);
  let snap = (await api(app.base, 'GET', `/api/takes/${T}/snapshot`, null, caller.sessionToken)).data;
  assert.equal(snap.cues.find((c) => c.id === 'L1').state.state, 'waiting', 'testimony must not advance the playhead');

  // caller holds with a reason
  r = await command(app.base, T, caller.sessionToken, { kind: 'HOLD', payload: { reason: 'missed entrance' } });
  assert.equal(r.status, 201);

  // no new cue advances while held
  const heldTry = await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'S1' });
  assert.equal(heldTry.status, 409);
  assert.equal(heldTry.data.error, 'held');

  // explicit skip with path choice + reason
  r = await command(app.base, T, caller.sessionToken, { kind: 'SKIP', cueId: 'E1', payload: { reason: 'no entrance observed', path: 'allow' } });
  assert.equal(r.status, 201);

  // resume requires destination + reason and bumps the epoch
  r = await command(app.base, T, caller.sessionToken, { kind: 'RESUME', payload: { destination: 'S1', reason: 'pick up at the chime' } });
  assert.equal(r.status, 201);
  snap = (await api(app.base, 'GET', `/api/takes/${T}/snapshot`, null, caller.sessionToken)).data;
  assert.equal(snap.take.epoch, 2);
  assert.equal(snap.take.status, 'active');
  assert.equal(snap.cues.find((c) => c.id === 'S1').state.state, 'standby', 'resume exposes the selected standby');
  assert.equal(snap.cues.find((c) => c.id === 'E1').state.state, 'skipped');

  // the desk acknowledges only after the new standby
  r = await command(app.base, T, sound.sessionToken, { kind: 'ACK', cueId: 'S1', epoch: 2 });
  assert.equal(r.status, 201);
  r = await command(app.base, T, caller.sessionToken, { kind: 'GO', cueId: 'S1', epoch: 2 });
  assert.equal(r.status, 201);

  // inspect the persisted sequence end to end
  const ev = (await api(app.base, 'GET', `/api/takes/${T}/events?after=0`, null, caller.sessionToken)).data;
  const kinds = ev.events.map((e) => `${e.seq}:${e.kind}:${e.cueId ?? '-'}`);
  assert.deepEqual(kinds, [
    '1:STANDBY:E1',
    '2:OBSERVED_GO:L1',
    '3:HOLD:-',
    '4:SKIP:E1',
    '5:RESUME:-',
    '6:ACK:S1',
    '7:GO:S1',
  ]);
  assert.equal(ev.events[4].epoch, 2, 'RESUME records the new epoch');
  assert.equal(ev.events[3].payload.reason, 'no entrance observed');
  assert.equal(ev.events[4].payload.destination, 'S1');
});
