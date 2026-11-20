/**
 * Initialize an explicitly public demo production: scene, room and three
 * role invitations. Prints the owner token and join URLs — treat these as
 * judge-private credentials. Usage:
 *
 *   npm run build
 *   SG_DB=./data/demo.db node scripts/seed-demo.mjs [--base http://localhost:8080]
 *
 * Then run `npm start` with the same SG_DB and hand the join URLs to the
 * three "desks" (or open them yourself in three browsers).
 */
import { openDatabase } from '../dist/db/database.js';
import { createProduction, importScript } from '../dist/domain/store.js';
import { createRoom, createInvitation } from '../dist/domain/rooms.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseArg = process.argv.find((a) => a.startsWith('--base='));
const base = baseArg ? baseArg.split('=')[1] : 'http://localhost:8080';
const dbPath = process.env.SG_DB ?? path.join(root, 'data', 'demo.db');

const db = openDatabase(dbPath);
const prod = createProduction(db, 'Judge demo — The returning letter', true);
const csv = readFileSync(path.join(root, 'fixtures', 'the-returning-letter.csv'), 'utf8');
const imp = importScript(db, prod.id, csv, 'The returning letter');
if (!imp.ok) {
  console.error('import failed', imp.errors);
  process.exit(1);
}
const room = createRoom(db, prod.id, imp.revision.id, 'Judge demo room');
const seats = [
  ['caller', 'Caller'],
  ['sound', 'Sound desk'],
  ['lights', 'Lights desk'],
];
console.log(`demo production: ${prod.id} (public reads enabled)`);
console.log(`owner token (judge-private): ${prod.ownerToken}`);
console.log(`room: ${room.id}`);
for (const [role, name] of seats) {
  const { token, invitation } = createInvitation(db, room.id, role, name, 24 * 60);
  console.log(`  ${role.padEnd(7)} join: ${base}/join/${token}  (expires ${invitation.expiresAt})`);
}
db.close();
