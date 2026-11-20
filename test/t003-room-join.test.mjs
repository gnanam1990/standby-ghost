import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeProduction, FIXTURE_CSV } from './helpers.mjs';

async function setupRoom(t) {
  const app = await spawnApp();
  t.after(() => app.close());
  const prod = await makeProduction(app.base);
  const rev = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: FIXTURE_CSV, title: 'R1',
  }, prod.ownerToken);
  const room = await api(app.base, 'POST', `/api/productions/${prod.id}/rooms`, {
    scriptRevisionId: rev.data.revision.id, name: 'Night one',
  }, prod.ownerToken);
  assert.equal(room.status, 201);
  return { app, prod, room: room.data.room };
}

async function invite(base, roomId, role, name, ownerToken) {
  const { status, data } = await api(base, 'POST', `/api/rooms/${roomId}/invitations`, {
    role, name, ttlMinutes: 60,
  }, ownerToken);
  assert.equal(status, 201);
  return data;
}

async function join(base, token, name) {
  return api(base, 'POST', '/api/join', { token, name });
}

// T-003: Join real caller, sound and lights clients; identify each desk by
// its visible name and role.
test('T-003 three distinct role invitations join and show on the roster', async (t) => {
  const { app, prod, room } = await setupRoom(t);
  const seats = [
    ['caller', 'Priya'],
    ['sound', 'Theo'],
    ['lights', 'June'],
  ];
  const joined = [];
  for (const [role, name] of seats) {
    const inv = await invite(app.base, room.id, role, name, prod.ownerToken);
    assert.match(inv.joinUrl, /^\/join\//);
    const res = await join(app.base, inv.token, name);
    assert.equal(res.status, 201);
    assert.equal(res.data.member.role, role);
    assert.equal(res.data.member.name, name);
    assert.equal(res.data.member.generation, 1);
    joined.push(res.data);
  }
  // all three sessions are distinct and valid
  assert.equal(new Set(joined.map((j) => j.sessionToken)).size, 3);

  const roomInfo = await api(app.base, 'GET', `/api/rooms/${room.id}`, null, prod.ownerToken);
  const members = roomInfo.data.roster.members;
  assert.equal(members.length, 3);
  for (const [role, name] of seats) {
    const m = members.find((x) => x.role === role && x.name === name);
    assert.ok(m, `roster must show ${name} as ${role}`);
    assert.equal(m.status, 'active');
  }
});

// Desk replacement: producer revokes the old sound member; the replacement
// joins at generation 2 and the old session is dead.
test('T-003b replace a desk operator and revoke its generation', async (t) => {
  const { app, prod, room } = await setupRoom(t);
  const inv1 = await invite(app.base, room.id, 'sound', 'Theo', prod.ownerToken);
  const s1 = await join(app.base, inv1.token, 'Theo');
  const inv2 = await invite(app.base, room.id, 'caller', 'Priya', prod.ownerToken);
  await join(app.base, inv2.token, 'Priya');

  await api(app.base, 'POST', `/api/rooms/${room.id}/members/${s1.data.member.id}/revoke`, {}, prod.ownerToken);
  const inv3 = await invite(app.base, room.id, 'sound', 'Ada', prod.ownerToken);
  const s2 = await join(app.base, inv3.token, 'Ada');
  assert.equal(s2.status, 201);
  assert.equal(s2.data.member.generation, 2);

  const roster = (await api(app.base, 'GET', `/api/rooms/${room.id}`, null, prod.ownerToken)).data.roster.members;
  assert.equal(roster.find((m) => m.name === 'Theo').status, 'revoked');
  assert.equal(roster.find((m) => m.name === 'Ada').status, 'active');

  // old session is dead server-side: reads and writes are both denied
  const me = await api(app.base, 'GET', `/api/rooms/${room.id}`, null, s1.data.sessionToken);
  assert.equal(me.status, 403);
  const takeTry = await api(app.base, 'POST', `/api/rooms/${room.id}/takes`, {}, s1.data.sessionToken);
  assert.equal(takeTry.status, 403);
});
