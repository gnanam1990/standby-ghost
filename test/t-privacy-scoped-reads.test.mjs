import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApp, api, makeProduction, makeRehearsal, FIXTURE_CSV, command } from './helpers.mjs';

// Release privacy acceptance: private production material is readable only
// by the production owner or a current authorized room role; only explicit
// demo assets are public.
test('private production reads are denied to anonymous and other-production members', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());

  const a = await makeRehearsal(app); // production A with room + take
  const prodB = await makeProduction(app.base, 'Other prod');
  const revB = await api(app.base, 'POST', `/api/productions/${prodB.id}/scripts`, {
    csv: FIXTURE_CSV, title: 'B scene',
  }, prodB.ownerToken);

  // anonymous: everything private is denied
  for (const path of [
    `/api/productions/${a.prod.id}`,
    `/api/scripts/${revB.data.revision.id}`,
    `/api/scripts/${revB.data.revision.id}/export.csv`,
    `/api/rooms/${a.room.id}`,
    `/api/rooms/${a.room.id}/roster`,
    `/api/takes/${a.take.id}`,
    `/api/takes/${a.take.id}/events`,
    `/api/takes/${a.take.id}/snapshot`,
  ]) {
    const res = await api(app.base, 'GET', path);
    assert.equal(res.status, 403, `${path} must deny anonymous reads`);
  }

  // a member of production A cannot read production B's material
  const foreign = await api(app.base, 'GET', `/api/productions/${prodB.id}`, null, a.sessions.caller.sessionToken);
  assert.equal(foreign.status, 403);
  const foreignScript = await api(app.base, 'GET', `/api/scripts/${revB.data.revision.id}`, null, a.sessions.sound.sessionToken);
  assert.equal(foreignScript.status, 403);

  // legitimate reads still work: owner and each desk role
  for (const token of [a.prod.ownerToken, a.sessions.caller.sessionToken, a.sessions.sound.sessionToken, a.sessions.lights.sessionToken]) {
    const prodRead = await api(app.base, 'GET', `/api/productions/${a.prod.id}`, null, token);
    assert.equal(prodRead.status, 200, 'owner and room roles read their production');
    const snap = await api(app.base, 'GET', `/api/takes/${a.take.id}/snapshot`, null, token);
    assert.equal(snap.status, 200, 'owner and room roles read the take snapshot');
  }

  // directory lists only demo productions
  const dir = await api(app.base, 'GET', '/api/productions');
  assert.equal(dir.status, 200);
  assert.ok(!dir.data.productions.some((p) => p.id === a.prod.id), 'private productions are not listed');
});

test('explicit demo productions are publicly readable but not writable', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const { data: demo } = await api(app.base, 'POST', '/api/productions', {
    name: 'Public demo', isDemo: true,
  });
  const rev = await api(app.base, 'POST', `/api/productions/${demo.id}/scripts`, {
    csv: FIXTURE_CSV, title: 'Demo scene',
  }, demo.ownerToken);
  const room = await api(app.base, 'POST', `/api/productions/${demo.id}/rooms`, {
    scriptRevisionId: rev.data.revision.id, name: 'Demo room',
  }, demo.ownerToken);
  // one joined desk so a take exists
  const inv = await api(app.base, 'POST', `/api/rooms/${room.data.room.id}/invitations`, {
    role: 'caller', name: 'Caller',
  }, demo.ownerToken);
  const joined = await api(app.base, 'POST', '/api/join', { token: inv.data.token, name: 'Caller' });
  const take = await api(app.base, 'POST', `/api/rooms/${room.data.room.id}/takes`, {}, joined.data.sessionToken);

  // anonymous reads succeed on the demo path
  for (const path of [
    `/api/productions/${demo.id}`,
    `/api/scripts/${rev.data.revision.id}`,
    `/api/scripts/${rev.data.revision.id}/export.csv`,
    `/api/rooms/${room.data.room.id}`,
    `/api/takes/${take.data.take.id}`,
    `/api/takes/${take.data.take.id}/events`,
    `/api/takes/${take.data.take.id}/snapshot`,
  ]) {
    const res = await api(app.base, 'GET', path);
    assert.equal(res.status, 200, `${path} should be public on a demo production`);
  }
  const dir = await api(app.base, 'GET', '/api/productions');
  assert.ok(dir.data.productions.some((p) => p.id === demo.id), 'demo productions are listed');

  // but writes still require their roles
  const noOwner = await api(app.base, 'POST', `/api/productions/${demo.id}/scripts`, {
    csv: FIXTURE_CSV, title: 'hijack',
  });
  assert.equal(noOwner.status, 403);
  const noCommand = await api(app.base, 'POST', `/api/takes/${take.data.take.id}/commands`, {
    commandId: 'x', epoch: 1, kind: 'HOLD', payload: { reason: 'x' },
  });
  assert.equal(noCommand.status, 403);
});
