import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CSV = readFileSync(path.join(root, 'fixtures/the-returning-letter.csv'), 'utf8');
const BASE = 'http://127.0.0.1:8189';

async function api(method, p, body, token) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body != null ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/** Production + scene + room + three joined roles + take. */
async function seed() {
  const prod = await api('POST', '/api/productions', { name: 'E2E release' });
  const rev = await api('POST', `/api/productions/${prod.id}/scripts`,
    { csv: CSV, title: 'The returning letter' }, prod.ownerToken);
  const room = await api('POST', `/api/productions/${prod.id}/rooms`,
    { scriptRevisionId: rev.revision.id, name: 'Night one' }, prod.ownerToken);
  const sessions = {};
  for (const [role, name] of [['caller', 'Priya'], ['sound', 'Theo'], ['lights', 'June']]) {
    const inv = await api('POST', `/api/rooms/${room.room.id}/invitations`,
      { role, name, ttlMinutes: 60 }, prod.ownerToken);
    sessions[role] = await api('POST', '/api/join', { token: inv.token, name });
  }
  const take = await api('POST', `/api/rooms/${room.room.id}/takes`, {}, sessions.caller.sessionToken);
  return { room: room.room, sessions, take: take.take };
}

/** A browser context pre-seeded with one role's room credentials. */
async function roleContext(browser, roomId, takeId, joined) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(
    ([rid, tid, session, member]) => {
      localStorage.setItem('sg-rooms', JSON.stringify([rid]));
      localStorage.setItem(`sg-session:${rid}`, session);
      localStorage.setItem(`sg-member:${rid}`, member);
      localStorage.setItem(`sg-take-room:${tid}`, rid);
    },
    [roomId, takeId, joined.sessionToken, JSON.stringify(joined.member)],
  );
  return ctx;
}

// Real three-browser release test: caller holds & resumes while the sound
// desk is offline; the queued ack predates the new epoch, so reconnect must
// force a reconfirm before it can be sent (FR-08 / T-008, live edition).
test('three roles, offline queue + epoch reconfirm across reconnect', async ({ browser }) => {
  const { room, sessions, take } = await seed();

  const callerCtx = await roleContext(browser, room.id, take.id, sessions.caller);
  const soundCtx = await roleContext(browser, room.id, take.id, sessions.sound);
  const lightsCtx = await roleContext(browser, room.id, take.id, sessions.lights);
  const caller = await callerCtx.newPage();
  const sound = await soundCtx.newPage();
  const lights = await lightsCtx.newPage();

  try {
    // caller walks the chain to a sound standby using only the real UI.
    // Waits observe post-refresh DOM so the console's expectedSeq cursor
    // has caught up before the next command is issued.
    await caller.goto(`/caller.html?take=${take.id}`);
    const e1 = caller.locator('#cue-table tr', { hasText: 'E1' });
    const s1 = caller.locator('#cue-table tr', { hasText: 'S1' });
    await e1.getByRole('button', { name: 'Standby' }).click();
    await expect(e1).toContainText('standby');
    await e1.getByRole('button', { name: 'Entrance' }).click();
    await expect(e1).toContainText('observed');
    await s1.getByRole('button', { name: 'Standby' }).click();
    await expect(s1).toContainText('standby');

    // both desks join live
    await sound.goto(`/desk.html?take=${take.id}`);
    await expect(sound.locator('#standby-line')).toContainText('S1');
    await lights.goto(`/desk.html?take=${take.id}`);
    await expect(lights.locator('#conn')).toHaveText('connected');

    // sound loses the network mid-standby — the ack must stay reachable
    await soundCtx.setOffline(true);
    await expect(sound.locator('#conn')).toContainText('offline');
    await expect(sound.locator('#ack-btn')).toBeEnabled();
    await sound.click('#ack-btn');
    await expect(sound.locator('#outbox-list')).toContainText('ACK S1 — pending');

    // caller holds and resumes back to S1 — epoch bumps while sound is away
    await caller.click('#hold-btn');
    await caller.fill('#hold-reason', 'actor missed the entrance');
    await caller.click('#hold-confirm');
    await expect(caller.locator('#action-status')).toContainText('HOLD');
    await caller.selectOption('#resume-dest', 'S1');
    await caller.fill('#resume-reason', 'reset to the sound standby');
    await caller.click('#resume-confirm');
    await expect(caller.locator('#action-status')).toContainText('RESUME');

    // the lights desk saw the whole recovery live
    await expect(lights.locator('#event-table')).toContainText('RESUME');

    // sound reconnects: its queued ack predates the new epoch → reconfirm
    await soundCtx.setOffline(false);
    await expect(sound.locator('#conn')).toHaveText('connected', { timeout: 10_000 });
    await expect(sound.locator('#outbox-list')).toContainText('reconfirm');
    await sound.getByRole('button', { name: 'Reconfirm & send' }).click();
    await expect(sound.locator('#outbox-list')).toContainText('ACK S1 — accepted');

    // and the accepted ack is visible on the other desk's log
    await expect(lights.locator('#event-table')).toContainText('ACK');
  } finally {
    await Promise.all([callerCtx.close(), soundCtx.close(), lightsCtx.close()]);
  }
});
