import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnApp, api, makeRehearsal, command, nextCommandId } from './helpers.mjs';

function openWs(base, sessionToken) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?session=${sessionToken}`);
  const messages = [];
  ws.addEventListener('message', (ev) => messages.push(JSON.parse(ev.data)));
  return { ws, messages, open: () => once(ws, 'open') };
}

// T-013: reassign the sound desk; the old generation's socket is dead —
// a fresh-looking ACK on it changes nothing and the roster shows the swap.
test('T-013 stale generation socket is inert; roster announces the swap', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { prod, room, sessions, take } = await makeRehearsal(app);
  const { caller, sound } = sessions;
  const T = take.id;

  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1' });
  await command(app.base, T, caller.sessionToken, { kind: 'ENTRANCE', cueId: 'E1' });
  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'S1' });

  // old desk is connected when the owner replaces it
  const stale = openWs(app.base, sound.sessionToken);
  await stale.open();
  const inv2 = await api(app.base, 'POST', `/api/rooms/${room.id}/invitations`,
    { role: 'sound', name: 'Theo2', ttlMinutes: 60 }, prod.ownerToken);
  const joined2 = await api(app.base, 'POST', '/api/join', { token: inv2.data.token, name: 'Theo2' });
  await api(app.base, 'POST', `/api/rooms/${room.id}/members/${sound.member.id}/revoke`,
    {}, prod.ownerToken);

  // a subscribe on the still-open stale socket is refused and the socket dies
  stale.ws.send(JSON.stringify({ type: 'subscribe', takeId: T, after: 0 }));
  for (let i = 0; i < 40 && !stale.messages.some((m) => m.type === 'error'); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const err = stale.messages.find((m) => m.type === 'error');
  assert.ok(err, 'stale socket receives an error');
  assert.equal(err.code, 'revoked');
  const close = once(stale.ws, 'close');
  await Promise.race([close, new Promise((r) => setTimeout(r, 2000))]);
  assert.ok(stale.ws.readyState === WebSocket.CLOSED || stale.ws.readyState === WebSocket.CLOSING,
    'server closes the revoked socket');

  // the old generation's HTTP command changes nothing
  const before = (await api(app.base, 'GET', `/api/takes/${T}/events?after=0`,
    null, caller.sessionToken)).data.events.length;
  const staleAck = await command(app.base, T, sound.sessionToken,
    { kind: 'ACK', cueId: 'S1', commandId: nextCommandId('stale-ack') });
  assert.equal(staleAck.status, 403);
  const after = (await api(app.base, 'GET', `/api/takes/${T}/events?after=0`,
    null, caller.sessionToken)).data.events.length;
  assert.equal(after, before);

  // a brand-new socket for the old token never even opens
  const dead = new WebSocket(`${app.base.replace('http', 'ws')}/ws?session=${sound.sessionToken}`);
  const outcome = await Promise.race([
    once(dead, 'error').then(() => 'error'),
    once(dead, 'open').then(() => 'open'),
  ]);
  assert.equal(outcome, 'error', 'revoked session upgrade is refused');

  // the replacement's generation works, and the roster tells both stories
  const roster = (await api(app.base, 'GET', `/api/rooms/${room.id}/roster`,
    null, prod.ownerToken)).data.roster.members;
  assert.equal(roster.find((m) => m.id === sound.member.id).status, 'revoked');
  assert.equal(roster.find((m) => m.id === joined2.data.member.id).status, 'active');
  assert.ok(joined2.data.member.generation > sound.member.generation);
  const liveAck = await command(app.base, T, joined2.data.sessionToken,
    { kind: 'ACK', cueId: 'S1' });
  assert.equal(liveAck.status, 201);
});
