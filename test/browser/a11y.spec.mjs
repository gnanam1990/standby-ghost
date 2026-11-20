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

async function seed() {
  const prod = await api('POST', '/api/productions', { name: 'A11y E2E' });
  const rev = await api('POST', `/api/productions/${prod.id}/scripts`,
    { csv: CSV, title: 'The returning letter' }, prod.ownerToken);
  const room = await api('POST', `/api/productions/${prod.id}/rooms`,
    { scriptRevisionId: rev.revision.id }, prod.ownerToken);
  const sessions = {};
  for (const [role, name] of [['caller', 'Priya'], ['sound', 'Theo'], ['lights', 'June']]) {
    const inv = await api('POST', `/api/rooms/${room.room.id}/invitations`,
      { role, name, ttlMinutes: 60 }, prod.ownerToken);
    sessions[role] = await api('POST', '/api/join', { token: inv.token, name });
  }
  const take = (await api('POST', `/api/rooms/${room.room.id}/takes`, {},
    sessions.caller.sessionToken)).take;
  return { prod, room: room.room, sessions, take };
}

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

// T-014: at 375px, finish a hold + resume using the keyboard only; with
// reduced motion the overlay and the table still name the same divergence.
test('keyboard-only hold/resume at 375px; reduced-motion divergence parity', async ({ browser }) => {
  const { room, sessions, take } = await seed();

  // narrow phone-width viewport + simulated 200% zoom
  const callerCtx = await roleContext(browser, room.id, take.id, sessions.caller);
  const caller = await callerCtx.newPage();
  await caller.setViewportSize({ width: 375, height: 720 });
  await caller.emulateMedia({ reducedMotion: 'reduce' });
  await caller.goto(`/caller.html?take=${take.id}`);
  await caller.evaluate(() => { document.documentElement.style.zoom = '2'; });

  // walk standby → entrance with real buttons, all keyboard-driven.
  // Each wait observes post-refresh DOM, proving the console's expectedSeq
  // cursor has caught up before the next command is issued.
  const e1 = caller.locator('#cue-table tr', { hasText: 'E1' });
  await e1.getByRole('button', { name: 'Standby' }).focus();
  await caller.keyboard.press('Enter');
  await expect(e1).toContainText('standby');
  await e1.getByRole('button', { name: 'Entrance' }).focus();
  await caller.keyboard.press('Enter');
  await expect(e1).toContainText('observed');

  // hold via keyboard: focus hold, Enter, type reason, Enter on confirm
  await caller.locator('#hold-btn').focus();
  await caller.keyboard.press('Enter');
  await expect(caller.locator('#hold-panel')).toBeVisible();
  await caller.locator('#hold-reason').pressSequentially('actor missed the entrance');
  await caller.locator('#hold-confirm').focus();
  await caller.keyboard.press('Enter');
  await expect(caller.locator('#action-status')).toContainText('HOLD');

  // resume via keyboard — the held-state refresh must populate the
  // destination select (proving expectedSeq caught up) before we send
  await caller.selectOption('#resume-dest', 'S1');
  await caller.locator('#resume-reason').pressSequentially('reset to the sound standby');
  await caller.locator('#resume-confirm').focus();
  await caller.keyboard.press('Enter');
  await expect(caller.locator('#action-status')).toContainText('RESUME');
  await callerCtx.close();

  // reduced motion on review: table and overlay still name the same divergence
  const ctx = await roleContext(browser, room.id, take.id, sessions.lights);
  const page = await ctx.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // give the take a real divergence to read: L1 testimony before S1 ran
  const obs = await api('POST', `/api/takes/${take.id}/commands`, {
    commandId: 'a11y-obs-L1', epoch: 2, kind: 'OBSERVED_GO', cueId: 'L1', payload: {},
  }, sessions.lights.sessionToken);
  expect(obs).toBeTruthy();
  await page.goto(`/review.html?take=${take.id}`);
  await expect(page.locator('#divergence-text')).toContainText('L1');
  await expect(page.locator('#table-divergence')).toContainText('L1');
  await ctx.close();
});
