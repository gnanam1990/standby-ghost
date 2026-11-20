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

// FR-11/FR-12 in a real browser: the owner reviews take 1's divergence,
// cuts the corrected revision from the handoff section, downloads the
// corrected sheet, repins the room, and a second take pins the new
// revision — while take 1 stays sealed on the original.
test('owner handoff: review → corrected revision → export → repin → take 2', async ({ browser }) => {
  const prod = await api('POST', '/api/productions', { name: 'Handoff E2E' });
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
  const cmd = (kind, cueId, session) =>
    api('POST', `/api/takes/${take.id}/commands`,
      { commandId: `h-${kind}-${cueId ?? 'x'}`, epoch: 1, kind, cueId, payload: {} }, session);
  await cmd('STANDBY', 'E1', sessions.caller.sessionToken);
  await cmd('ENTRANCE', 'E1', sessions.caller.sessionToken);
  await cmd('STANDBY', 'S1', sessions.caller.sessionToken);
  await cmd('OBSERVED_GO', 'L1', sessions.lights.sessionToken);
  await cmd('FINISH', undefined, sessions.caller.sessionToken);

  // owner context: session-scoped owner token, no joined seat
  const ownerCtx = await browser.newContext();
  await ownerCtx.addInitScript(
    ([pid, token]) => sessionStorage.setItem(`owner:${pid}`, token),
    [prod.id, prod.ownerToken],
  );
  const page = await ownerCtx.newPage();
  await page.goto(`/review.html?take=${take.id}&prod=${prod.id}`);

  // review renders and the owner handoff section appears
  await expect(page.locator('#divergence-text')).toContainText('L1');
  await expect(page.locator('#handoff-section')).toBeVisible();

  // the textarea is prefilled with the exported sheet; correct L1's dep
  const corrected = CSV.replace('L1,lights,Warm front light up,S1,caller',
    'L1,lights,Warm front light up,E1,caller');
  await page.fill('#rev-csv', corrected);
  await page.fill('#rev-note', 'SM approved: L1 follows the entrance directly');
  await page.click('#rev-create');
  await expect(page.locator('#rev-status')).toContainText('Created R2');
  await expect(page.locator('#rev-done')).toBeVisible();

  // corrected calling sheet downloads once through the authenticated fetch
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.click('#rev-export');
  await page.waitForTimeout(500);
  expect(downloads).toHaveLength(1);

  // repin the room and start take 2 — it pins the corrected revision
  await page.click('#repin-btn');
  await expect(page.locator('#repin-status')).toContainText('corrected revision');
  const t2 = await api('POST', `/api/rooms/${room.room.id}/takes`, {}, sessions.caller.sessionToken);
  const rev2 = (await api('GET', `/api/takes/${t2.take.id}`, null,
    sessions.caller.sessionToken)).take.scriptRevisionId;
  expect(rev2).not.toBe(take.scriptRevisionId);

  // take 1 reopens sealed and pinned to the original revision
  await page.reload();
  await expect(page.locator('#review-sub')).toContainText('sealed');
  const cmp = await api('GET', `/api/takes/${take.id}/compare?other=${t2.take.id}`,
    null, sessions.caller.sessionToken);
  expect(cmp.a.scriptRevisionId).toBe(take.scriptRevisionId);
  expect(cmp.b.scriptRevisionId).toBe(rev2);

  // compare picker in the UI names take 2
  await page.selectOption('#compare-other', t2.take.id);
  await page.click('#compare-btn');
  await expect(page.locator('#compare-result')).toBeVisible();
  await expect(page.locator('#compare-result')).toContainText('other take');

  await ownerCtx.close();
});
