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
  return { app, prod, room: room.data.room };
}

// T-004: Reuse a revoked link or send a caller command from a desk; reject it
// and preserve the take sequence.
test('T-004 revoked or used links are rejected', async (t) => {
  const { app, prod, room } = await setupRoom(t);
  const inv = await api(app.base, 'POST', `/api/rooms/${room.id}/invitations`, {
    role: 'sound', name: 'Theo',
  }, prod.ownerToken);

  // revoke before use
  await api(app.base, 'POST', `/api/rooms/${room.id}/invitations/${inv.data.invitation.id}/revoke`, {}, prod.ownerToken);
  const revoked = await api(app.base, 'POST', '/api/join', { token: inv.data.token, name: 'Theo' });
  assert.equal(revoked.status, 410);
  assert.equal(revoked.data.error, 'invitation_revoked');

  // used link cannot be redeemed twice
  const inv2 = await api(app.base, 'POST', `/api/rooms/${room.id}/invitations`, {
    role: 'sound', name: 'Theo',
  }, prod.ownerToken);
  assert.equal((await api(app.base, 'POST', '/api/join', { token: inv2.data.token, name: 'Theo' })).status, 201);
  const reuse = await api(app.base, 'POST', '/api/join', { token: inv2.data.token, name: 'Mallory' });
  assert.equal(reuse.status, 410);
  assert.equal(reuse.data.error, 'invitation_used');

  // expired link
  const inv3 = await api(app.base, 'POST', `/api/rooms/${room.id}/invitations`, {
    role: 'lights', name: 'June',
  }, prod.ownerToken);
  app.db.prepare(`UPDATE invitations SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?`)
    .run(inv3.data.invitation.id);
  const expired = await api(app.base, 'POST', '/api/join', { token: inv3.data.token, name: 'June' });
  assert.equal(expired.status, 410);
  assert.equal(expired.data.error, 'invitation_expired');
});

test('T-004b a desk cannot issue caller commands; take sequence preserved', async (t) => {
  const { app, prod, room } = await setupRoom(t);
  const mk = async (role, name) => {
    const inv = await api(app.base, 'POST', `/api/rooms/${room.id}/invitations`, { role, name }, prod.ownerToken);
    return (await api(app.base, 'POST', '/api/join', { token: inv.data.token, name })).data;
  };
  const caller = await mk('caller', 'Priya');
  const sound = await mk('sound', 'Theo');

  // desk tries the caller-only action "start a take"
  const denied = await api(app.base, 'POST', `/api/rooms/${room.id}/takes`, {}, sound.sessionToken);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error, 'forbidden_role');

  // anonymous has no seat at all
  const anon = await api(app.base, 'POST', `/api/rooms/${room.id}/takes`, {});
  assert.equal(anon.status, 403);

  // caller can start exactly one take; sequence preserved
  const take = await api(app.base, 'POST', `/api/rooms/${room.id}/takes`, {}, caller.sessionToken);
  assert.equal(take.status, 201);
  const info = await api(app.base, 'GET', `/api/rooms/${room.id}`, null, prod.ownerToken);
  assert.equal(info.data.takes.length, 1);
  assert.equal(info.data.takes[0].nextSeq, 1, 'no phantom events were recorded');
});
