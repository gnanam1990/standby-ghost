import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../util/crypto.js';
import type { Member } from './rooms.js';

export interface Take {
  id: string;
  roomId: string;
  scriptRevisionId: string;
  status: 'active' | 'held' | 'sealed';
  epoch: number;
  nextSeq: number;
  createdBy: string | null;
  createdAt: string;
  sealedAt: string | null;
}

export interface TakeRow {
  id: string;
  room_id: string;
  script_revision_id: string;
  status: string;
  epoch: number;
  next_seq: number;
  created_by: string | null;
  created_at: string;
  sealed_at: string | null;
}

export function takeFromRow(r: TakeRow): Take {
  return {
    id: r.id,
    roomId: r.room_id,
    scriptRevisionId: r.script_revision_id,
    status: r.status as Take['status'],
    epoch: r.epoch,
    nextSeq: r.next_seq,
    createdBy: r.created_by,
    createdAt: r.created_at,
    sealedAt: r.sealed_at,
  };
}

export function getTake(db: DatabaseSync, id: string): Take | null {
  const row = db.prepare('SELECT * FROM takes WHERE id = ?').get(id) as TakeRow | undefined;
  return row ? takeFromRow(row) : null;
}

export function listTakes(db: DatabaseSync, roomId: string): Take[] {
  const rows = db
    .prepare('SELECT * FROM takes WHERE room_id = ? ORDER BY created_at')
    .all(roomId) as unknown as TakeRow[];
  return rows.map(takeFromRow);
}

/**
 * Start a take pinned to the room's current script revision (INV-01):
 * later revisions never mutate a take that already started.
 */
export function createTake(db: DatabaseSync, roomId: string, scriptRevisionId: string, by: Member): Take {
  const id = newId('take');
  db.prepare(
    `INSERT INTO takes (id, room_id, script_revision_id, status, epoch, next_seq, created_by, created_at)
     VALUES (?, ?, ?, 'active', 1, 1, ?, ?)`,
  ).run(id, roomId, scriptRevisionId, by.id, new Date().toISOString());
  return getTake(db, id)!;
}
