import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnApp, api, makeProduction, FIXTURE_CSV, tmpDir } from './helpers.mjs';
import { rmSync } from 'node:fs';
import { openDatabase } from '../dist/db/database.js';
import { startServer } from '../dist/http/server.js';
import { repoRoot } from './helpers.mjs';

// T-001: Import an original scene with parallel sound and lights dependencies;
// export and re-import the cue order without identity drift.
test('T-001 import, export and re-import preserve cue identity and digest', async (t) => {
  const app = await spawnApp();
  t.after(() => app.close());
  const prod = await makeProduction(app.base, 'Returning Letter Co.');

  const imp = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: FIXTURE_CSV,
    title: 'The returning letter',
  }, prod.ownerToken);
  assert.equal(imp.status, 201);
  const r1 = imp.data.revision;
  assert.equal(r1.seq, 1);
  assert.equal(r1.cues.length, 5);
  // parallel deps present
  const l2 = r1.cues.find((c) => c.id === 'L2');
  const s2 = r1.cues.find((c) => c.id === 'S2');
  assert.deepEqual(l2.deps, ['L1']);
  assert.deepEqual(s2.deps, ['L1']);
  assert.deepEqual(r1.callingOrder, ['E1', 'S1', 'L1', 'L2', 'S2']);

  const exp = await fetch(`${app.base}/api/scripts/${r1.id}/export.csv`);
  assert.equal(exp.status, 200);
  const csvOut = await exp.text();

  const reImp = await api(app.base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: csvOut,
    title: 'Re-imported',
  }, prod.ownerToken);
  assert.equal(reImp.status, 201);
  const r2 = reImp.data.revision;
  assert.equal(r2.seq, 2);
  assert.equal(r2.parentId, r1.id);
  assert.equal(r2.digest, r1.digest, 'digest must not drift');
  assert.deepEqual(r2.cues.map((c) => c.id), r1.cues.map((c) => c.id), 'cue ids must not drift');
  assert.deepEqual(r2.callingOrder, r1.callingOrder);
});

// T-001 boundary: durability across a server restart on the same DB file.
test('T-001b imported revision survives a server restart', async (t) => {
  const dir = tmpDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'persist.db');

  let db = openDatabase(dbPath);
  let app = await startServer({ port: 0, dbPath, staticDir: path.join(repoRoot, 'public') }, db);
  const base = `http://127.0.0.1:${app.port}`;
  const prod = await makeProduction(base, 'Restart Co.');
  const imp = await api(base, 'POST', `/api/productions/${prod.id}/scripts`, {
    csv: FIXTURE_CSV, title: 'R1',
  }, prod.ownerToken);
  assert.equal(imp.status, 201);
  const revId = imp.data.revision.id;
  const digest = imp.data.revision.digest;
  await app.close();
  db.close();

  db = openDatabase(dbPath);
  app = await startServer({ port: 0, dbPath, staticDir: path.join(repoRoot, 'public') }, db);
  const base2 = `http://127.0.0.1:${app.port}`;
  const got = await api(base2, 'GET', `/api/scripts/${revId}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.revision.digest, digest);
  assert.equal(got.data.revision.cues.length, 5);
  await app.close();
  db.close();
});
