import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../dist/db/database.js';
import { startServer } from '../dist/http/server.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_CSV = readFileSync(
  path.join(repoRoot, 'fixtures', 'the-returning-letter.csv'),
  'utf8',
);

export function tmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'sg-test-'));
}

export async function spawnApp({ dbPath } = {}) {
  const dir = tmpDir();
  const db = openDatabase(dbPath ?? path.join(dir, 'test.db'));
  const handle = await startServer({ port: 0, dbPath: dbPath ?? ':memory:', staticDir: path.join(repoRoot, 'public') }, db);
  const base = `http://127.0.0.1:${handle.port}`;
  return {
    base,
    db,
    dir,
    async close() {
      await handle.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function api(base, method, p, body, token) {
  const headers = {};
  if (body != null) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

export async function makeProduction(base, name = 'Test Prod') {
  const { status, data } = await api(base, 'POST', '/api/productions', { name });
  if (status !== 201) throw new Error(`create production failed: ${JSON.stringify(data)}`);
  return data;
}

/**
 * Full scenario: production + scene + room + three joined roles + take.
 * Returns sessions keyed by role for issuing commands.
 */
export async function makeRehearsal(app) {
  const prod = await makeProduction(app.base);
  const rev = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: FIXTURE_CSV, title: 'The returning letter',
  }, prod.ownerToken);
  const room = await api(app.base, 'POST', `/api/productions/${prod.id}/rooms`, {
    scriptRevisionId: rev.data.revision.id, name: 'Night one',
  }, prod.ownerToken);
  const sessions = {};
  for (const [role, name] of [['caller', 'Priya'], ['sound', 'Theo'], ['lights', 'June']]) {
    const inv = await api(app.base, 'POST', `/api/rooms/${room.data.room.id}/invitations`, {
      role, name, ttlMinutes: 60,
    }, prod.ownerToken);
    const joined = await api(app.base, 'POST', '/api/join', { token: inv.data.token, name });
    sessions[role] = joined.data;
  }
  const take = await api(app.base, 'POST', `/api/rooms/${room.data.room.id}/takes`, {}, sessions.caller.sessionToken);
  return {
    prod,
    room: room.data.room,
    sessions,
    take: take.data.take,
  };
}

let cmdCounter = 0;
export function nextCommandId(tag = 'cmd') {
  return `${tag}-${Date.now()}-${cmdCounter++}`;
}

/** Issue a take command; returns {status, data}. */
export async function command(base, takeId, session, { kind, cueId, epoch = 1, expectedSeq, payload = {}, commandId }) {
  const body = { commandId: commandId ?? nextCommandId(kind), epoch, kind, payload };
  if (cueId) body.cueId = cueId;
  if (expectedSeq !== undefined) body.expectedSeq = expectedSeq;
  return api(base, 'POST', `/api/takes/${takeId}/commands`, body, session);
}
