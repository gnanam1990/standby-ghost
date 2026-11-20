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

// FR-09/FR-10 + NFR-02 in a real browser: a lights testimony for L1 before
// its predecessor S1 fired is the first divergence, and the overlay panel
// and the linear table must say the same thing in words.
test('ghost review shows first divergence in overlay and table alike', async ({ browser }) => {
  const prod = await api('POST', '/api/productions', { name: 'Review E2E' });
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
      { commandId: `e2e-${kind}-${cueId ?? 'x'}-${Date.now()}`, epoch: 1, kind, cueId, payload: {} },
      session);

  // entrance happens; S1 goes on standby but never fires; then lights
  // reports L1 fired before S1 ever did — the first divergence
  await cmd('STANDBY', 'E1', sessions.caller.sessionToken);
  await cmd('ENTRANCE', 'E1', sessions.caller.sessionToken);
  await cmd('STANDBY', 'S1', sessions.caller.sessionToken);
  await cmd('OBSERVED_GO', 'L1', sessions.lights.sessionToken);

  const ctx = await browser.newContext();
  await ctx.addInitScript(
    ([rid, tid, session, member]) => {
      localStorage.setItem('sg-rooms', JSON.stringify([rid]));
      localStorage.setItem(`sg-session:${rid}`, session);
      localStorage.setItem(`sg-member:${rid}`, member);
      localStorage.setItem(`sg-take-room:${tid}`, rid);
    },
    [room.room.id, take.id, sessions.lights.sessionToken, JSON.stringify(sessions.lights.member)],
  );
  const page = await ctx.newPage();
  await page.goto(`/review.html?take=${take.id}`);

  // overlay divergence panel
  await expect(page.locator('#divergence-text')).toContainText('L1');
  await expect(page.locator('#divergence-text')).toContainText('S1');
  // same divergence in the linear table — the reduced-motion path
  await expect(page.locator('#table-divergence')).toContainText('L1');
  await expect(page.locator('#compare-table')).toContainText('FIRST DIVERGENCE');
  // unobserved outcomes are evidence gaps, not failures
  await expect(page.locator('#unresolved-list')).toContainText('S1');

  // a stranger gets nothing
  const anon = await browser.newContext().then((c) => c.newPage());
  await anon.goto(`/review.html?take=${take.id}`);
  await expect(anon.locator('#review-sub')).toContainText('unavailable');

  await ctx.close();
  await anon.context().close();
});
