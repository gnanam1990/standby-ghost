import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnApp, api, makeRehearsal, command, nextCommandId } from './helpers.mjs';

function openWs(base, sessionToken) {
  const url = `${base.replace('http', 'ws')}/ws?session=${sessionToken}`;
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    messages.push(msg);
    for (const w of waiters.splice(0)) w(msg);
  });
  return {
    ws,
    messages,
    open: () => once(ws, 'open'),
    next: () => new Promise((r) => waiters.push(r)),
    close: () => ws.close(),
  };
}

// T-007: Disconnect a desk after the server accepted an ACK, reconnect and
// retry its original ID; show one event and the original acknowledgment.
test('T-007 ack survives disconnect; retry of original id returns one event', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { sessions, take } = await makeRehearsal(app);
  const { caller, sound } = sessions;
  const T = take.id;

  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'E1' });
  await command(app.base, T, caller.sessionToken, { kind: 'ENTRANCE', cueId: 'E1' });
  await command(app.base, T, caller.sessionToken, { kind: 'STANDBY', cueId: 'S1' });

  // desk connects, receives hello, sees live events on the socket
  const sock1 = openWs(app.base, sound.sessionToken);
  await sock1.open();
  const ackId = nextCommandId('ack');
  const ack = await command(app.base, T, sound.sessionToken, { kind: 'ACK', cueId: 'S1', commandId: ackId });
  assert.equal(ack.status, 201);
  const ackSeq = ack.data.event.seq;
  // wait for the broadcast frame
  for (let i = 0; i < 40 && !sock1.messages.some((m) => m.type === 'event' && m.event?.commandId === ackId); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(sock1.messages.some((m) => m.type === 'event' && m.event?.commandId === ackId), 'desk receives its own ack broadcast');
  sock1.close();

  // reconnect: snapshot + subsequent events via subscribe catch-up
  const sock2 = openWs(app.base, sound.sessionToken);
  await sock2.open();
  sock2.ws.send(JSON.stringify({ type: 'subscribe', takeId: T, after: 0 }));
  for (let i = 0; i < 40 && !sock2.messages.some((m) => m.type === 'events'); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const catchup = sock2.messages.find((m) => m.type === 'events');
  assert.ok(catchup, 'catch-up reply received');
  assert.equal(catchup.events.filter((e) => e.commandId === ackId).length, 1);

  // retry the ORIGINAL command id after reconnect: one event, original ack
  const retry = await command(app.base, T, sound.sessionToken, { kind: 'ACK', cueId: 'S1', commandId: ackId });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.event.seq, ackSeq);
  const ev = (await api(app.base, 'GET', `/api/takes/${T}/events?after=0`, null, sound.sessionToken)).data.events;
  assert.equal(ev.filter((e) => e.commandId === ackId).length, 1);
  sock2.close();
});
