import type { DatabaseSync } from 'node:sqlite';
import { newId, newToken, sha256 } from '../util/crypto.js';
import { withTransaction } from '../db/database.js';
import {
  digestCues,
  parseCsv,
  topoOrder,
  validateScene,
  type CueDef,
  type ImportError,
} from './script.js';

export interface Production {
  id: string;
  name: string;
  createdAt: string;
}

export interface Revision {
  id: string;
  productionId: string;
  parentId: string | null;
  seq: number;
  title: string;
  digest: string;
  createdAt: string;
  cues: CueDef[];
  callingOrder: string[];
}

interface RevisionRow {
  id: string;
  production_id: string;
  parent_id: string | null;
  seq: number;
  title: string;
  digest: string;
  source_csv: string;
  created_at: string;
}

interface CueRow {
  cue_id: string;
  lane: string;
  label: string;
  deps_json: string;
  trigger_kind: string;
  position: number;
}

function cueFromRow(r: CueRow): CueDef {
  return {
    id: r.cue_id,
    lane: r.lane as CueDef['lane'],
    label: r.label,
    deps: JSON.parse(r.deps_json) as string[],
    trigger: r.trigger_kind as CueDef['trigger'],
    position: r.position,
  };
}

export function createProduction(db: DatabaseSync, name: string) {
  const token = newToken();
  const id = newId('prod');
  db.prepare(
    'INSERT INTO productions (id, name, owner_token_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, name, sha256(token), new Date().toISOString());
  return { id, name, ownerToken: token };
}

export function getProduction(db: DatabaseSync, id: string): Production | null {
  const row = db
    .prepare('SELECT id, name, created_at FROM productions WHERE id = ?')
    .get(id) as { id: string; name: string; created_at: string } | undefined;
  return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
}

export function listProductions(db: DatabaseSync): Production[] {
  const rows = db
    .prepare('SELECT id, name, created_at FROM productions ORDER BY created_at')
    .all() as unknown as { id: string; name: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

/** Verify a bearer token against the production owner hash. */
export function isOwner(db: DatabaseSync, productionId: string, token: string | null): boolean {
  if (!token) return false;
  const row = db
    .prepare('SELECT owner_token_hash FROM productions WHERE id = ?')
    .get(productionId) as { owner_token_hash: string } | undefined;
  return !!row && row.owner_token_hash === sha256(token);
}

function loadRevision(db: DatabaseSync, row: RevisionRow): Revision {
  const cueRows = db
    .prepare('SELECT * FROM cues WHERE revision_id = ? ORDER BY position')
    .all(row.id) as unknown as CueRow[];
  const cues = cueRows.map(cueFromRow);
  return {
    id: row.id,
    productionId: row.production_id,
    parentId: row.parent_id,
    seq: row.seq,
    title: row.title,
    digest: row.digest,
    createdAt: row.created_at,
    cues,
    callingOrder: topoOrder(cues),
  };
}

export function getRevision(db: DatabaseSync, id: string): Revision | null {
  const row = db.prepare('SELECT * FROM script_revisions WHERE id = ?').get(id) as
    | RevisionRow
    | undefined;
  return row ? loadRevision(db, row) : null;
}

export function listRevisions(db: DatabaseSync, productionId: string): Revision[] {
  const rows = db
    .prepare('SELECT * FROM script_revisions WHERE production_id = ? ORDER BY seq')
    .all(productionId) as unknown as RevisionRow[];
  return rows.map((r) => loadRevision(db, r));
}

export type ImportOutcome =
  | { ok: true; revision: Revision }
  | { ok: false; errors: ImportError[] };

/**
 * Parse, validate and persist a new immutable script revision. On rejection
 * nothing is written, so the previous head revision is retained (T-002).
 */
export function importScript(
  db: DatabaseSync,
  productionId: string,
  csvText: string,
  title: string,
): ImportOutcome {
  const parsed = parseCsv(csvText);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const { cues, errors } = validateScene(parsed.rows);
  if (errors.length) return { ok: false, errors };

  return withTransaction(db, () => {
    const head = db
      .prepare(
        'SELECT id, seq FROM script_revisions WHERE production_id = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(productionId) as { id: string; seq: number } | undefined;
    const id = newId('rev');
    const seq = (head?.seq ?? 0) + 1;
    db.prepare(
      `INSERT INTO script_revisions
        (id, production_id, parent_id, seq, title, digest, source_csv, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      productionId,
      head?.id ?? null,
      seq,
      title,
      digestCues(cues),
      csvText,
      new Date().toISOString(),
    );
    const insert = db.prepare(
      `INSERT INTO cues (revision_id, cue_id, lane, label, deps_json, trigger_kind, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const cue of cues) {
      insert.run(id, cue.id, cue.lane, cue.label, JSON.stringify(cue.deps), cue.trigger, cue.position);
    }
    return { ok: true as const, revision: getRevision(db, id)! };
  });
}

/** Added/removed/changed cue ids relative to the parent revision. */
export function revisionChanges(
  db: DatabaseSync,
  revision: Revision,
): { added: string[]; removed: string[]; changed: string[] } {
  if (!revision.parentId) {
    return { added: revision.cues.map((c) => c.id), removed: [], changed: [] };
  }
  const parent = getRevision(db, revision.parentId);
  if (!parent) return { added: [], removed: [], changed: [] };
  const parentById = new Map(parent.cues.map((c) => [c.id, c]));
  const currentById = new Map(revision.cues.map((c) => [c.id, c]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const cue of revision.cues) {
    const prev = parentById.get(cue.id);
    if (!prev) {
      added.push(cue.id);
      continue;
    }
    if (
      prev.label !== cue.label ||
      prev.lane !== cue.lane ||
      prev.trigger !== cue.trigger ||
      JSON.stringify([...prev.deps].sort()) !== JSON.stringify([...cue.deps].sort())
    ) {
      changed.push(cue.id);
    }
  }
  const removed = parent.cues.filter((c) => !currentById.has(c.id)).map((c) => c.id);
  return { added, removed, changed };
}
