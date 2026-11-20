import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeRehearsal, command } from './helpers.mjs';
import { outboxDecision } from '../public/outbox.js';

// T-008: Queue an ACK offline and start a new take; the stale signal remains
// rejected or requires explicit reconfirmation in the new take.
test('T-008 offline-queued ack requires reconfirmation after take/epoch change', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { sessions, take, room } = await makeRehearsal(app);
  const { caller, sound } = sessions;

  // desk queued this while offline: it was never sent
  const queued = {
    commandId: 'queued-ack-1',
    takeId: take.id,
    epoch: 1,
    kind: 'ACK',
    cueId: 'S1',
    state: 'pending',
  };

  // same take continues: entry may be sent
  assert.equal(outboxDecision(queued, { takeId: take.id, epoch: 1 }), 'send');

  // caller resumes after a hold → epoch change → reconfirm required
  await command(app.base, take.id, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1' });
  await command(app.base, take.id, caller.sessionToken, { kind: 'HOLD', payload: { reason: 'x' } });
  await command(app.base, take.id, caller.sessionToken, {
    kind: 'RESUME', payload: { destination: 'E1', reason: 'x' },
  });
  assert.equal(outboxDecision(queued, { takeId: take.id, epoch: 2 }), 'reconfirm');

  // start a NEW take → queued entry for the old take requires reconfirmation
  const take2 = (await api(app.base, 'POST', `/api/rooms/${room.id}/takes`, {}, caller.sessionToken)).data.take;
  assert.equal(outboxDecision(queued, { takeId: take2.id, epoch: 1 }), 'reconfirm');

  // if it is force-sent to the old take anyway, it applies to the OLD take
  // only — it can never appear in the new take's event log
  const forced = await command(app.base, take.id, sound.sessionToken, {
    kind: 'ACK', cueId: 'E1', epoch: 2, commandId: 'queued-ack-1',
  });
  // E1 is on standby in take 1 after RESUME but lane is 'stage', not sound
  assert.equal(forced.status, 403);

  // a well-formed stale-epoch signal in the desk's own lane is rejected outright
  const stale = await command(app.base, take.id, sound.sessionToken, {
    kind: 'ACK', cueId: 'S1', epoch: 1,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'stale_epoch');

  const ev2 = (await api(app.base, 'GET', `/api/takes/${take2.id}/events?after=0`, null, sound.sessionToken)).data.events;
  assert.equal(ev2.length, 0, 'no prior-take action may appear in the new take');
});
