import type { DatabaseSync } from 'node:sqlite';
import { newId, newToken, sha256 } from '../util/crypto.js';
import { withTransaction } from '../db/database.js';

export const ROLES = ['caller', 'sound', 'lights'] as const;
export type Role = (typeof ROLES)[number];
export const DESK_ROLES: Role[] = ['sound', 'lights'];
export const MAX_ROOMS_PER_PRODUCTION = 50;
export const MAX_INVITE_TTL_MINUTES = 24 * 60;

export interface Room {
  id: string;
  productionId: string;
  scriptRevisionId: string;
  name: string;
  createdAt: string;
}

export interface Member {
  id: string;
  roomId: string;
  role: Role;
  name: string;
  generation: number;
  revokedAt: string | null;
  createdAt: string;
}

export interface Invitation {
  id: string;
  roomId: string;
  role: Role;
  name: string | null;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

interface RoomRow {
  id: string;
  production_id: string;
  script_revision_id: string;
  name: string;
  created_at: string;
}

interface MemberRow {
  id: string;
  room_id: string;
  role: string;
  name: string;
  generation: number;
  revoked_at: string | null;
  created_at: string;
}

interface InvitationRow {
  id: string;
  room_id: string;
  role: string;
  name: string | null;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

function roomFromRow(r: RoomRow): Room {
  return {
    id: r.id,
    productionId: r.production_id,
    scriptRevisionId: r.script_revision_id,
    name: r.name,
    createdAt: r.created_at,
  };
}

function memberFromRow(r: MemberRow): Member {
  return {
    id: r.id,
    roomId: r.room_id,
    role: r.role as Role,
    name: r.name,
    generation: r.generation,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  };
}

function invitationFromRow(r: InvitationRow): Invitation {
  return {
    id: r.id,
    roomId: r.room_id,
    role: r.role as Role,
    name: r.name,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    revokedAt: r.revoked_at,
  };
}

export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function createRoom(
  db: DatabaseSync,
  productionId: string,
  scriptRevisionId: string,
  name: string,
): Room {
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE production_id = ?').get(productionId) as {
      n: number;
    }
  ).n;
  if (count >= MAX_ROOMS_PER_PRODUCTION) {
    throw new DomainError(429, 'rate_limited', `room limit of ${MAX_ROOMS_PER_PRODUCTION} reached`);
  }
  const rev = db
    .prepare('SELECT id FROM script_revisions WHERE id = ? AND production_id = ?')
    .get(scriptRevisionId, productionId);
  if (!rev) throw new DomainError(422, 'invalid_input', 'unknown script revision for production');
  const id = newId('room');
  db.prepare(
    'INSERT INTO rooms (id, production_id, script_revision_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, productionId, scriptRevisionId, name, new Date().toISOString());
  return getRoom(db, id)!;
}

export function getRoom(db: DatabaseSync, id: string): Room | null {
  const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
  return row ? roomFromRow(row) : null;
}

export function createInvitation(
  db: DatabaseSync,
  roomId: string,
  role: Role,
  name: string | null,
  ttlMinutes: number,
): { invitation: Invitation; token: string } {
  if (!ROLES.includes(role)) {
    throw new DomainError(422, 'invalid_input', `role must be one of ${ROLES.join('|')}`);
  }
  const ttl = Math.min(Math.max(ttlMinutes, 1), MAX_INVITE_TTL_MINUTES);
  const token = newToken();
  const id = newId('inv');
  const expires = new Date(Date.now() + ttl * 60_000).toISOString();
  db.prepare(
    `INSERT INTO invitations (id, room_id, role, name, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, roomId, role, name, sha256(token), expires, new Date().toISOString());
  const row = db.prepare('SELECT * FROM invitations WHERE id = ?').get(id) as unknown as InvitationRow;
  return { invitation: invitationFromRow(row), token };
}

export type JoinResult =
  | { ok: true; member: Member; sessionToken: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * Redeem a single-use invitation. The new member's generation is
 * max(previous generations for that role in the room) + 1, so a replaced
 * desk's successor is distinguishable and old sessions stay revoked.
 */
export function joinRoom(db: DatabaseSync, token: string, name: string | null): JoinResult {
  const row = db
    .prepare('SELECT * FROM invitations WHERE token_hash = ?')
    .get(sha256(token)) as InvitationRow | undefined;
  if (!row) return { ok: false, status: 404, code: 'not_found', message: 'unknown invitation' };
  if (row.revoked_at) {
    return { ok: false, status: 410, code: 'invitation_revoked', message: 'invitation was revoked' };
  }
  if (row.used_at) {
    return { ok: false, status: 410, code: 'invitation_used', message: 'invitation already used' };
  }
  if (row.expires_at <= new Date().toISOString()) {
    return { ok: false, status: 410, code: 'invitation_expired', message: 'invitation expired' };
  }
  const memberName = (name ?? row.name ?? '').trim();
  if (!memberName) {
    return { ok: false, status: 422, code: 'invalid_input', message: 'name is required to join' };
  }
  return withTransaction(db, () => {
    const genRow = db
      .prepare('SELECT COALESCE(MAX(generation), 0) AS g FROM memberships WHERE room_id = ? AND role = ?')
      .get(row.room_id, row.role) as { g: number };
    const memberId = newId('mem');
    const sessionToken = newToken();
    db.prepare(
      `INSERT INTO memberships (id, room_id, role, name, generation, session_token_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(memberId, row.room_id, row.role, memberName, genRow.g + 1, sha256(sessionToken), new Date().toISOString());
    db.prepare('UPDATE invitations SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    const member = db.prepare('SELECT * FROM memberships WHERE id = ?').get(memberId) as unknown as MemberRow;
    return { ok: true as const, member: memberFromRow(member), sessionToken };
  });
}

/** Resolve a session bearer token to a live membership; null when revoked/unknown. */
export function memberBySession(db: DatabaseSync, token: string | null): Member | null {
  if (!token) return null;
  const row = db
    .prepare('SELECT * FROM memberships WHERE session_token_hash = ?')
    .get(sha256(token)) as MemberRow | undefined;
  if (!row || row.revoked_at) return null;
  return memberFromRow(row);
}

export function revokeMember(db: DatabaseSync, roomId: string, memberId: string): Member {
  const row = db
    .prepare('SELECT * FROM memberships WHERE id = ? AND room_id = ?')
    .get(memberId, roomId) as MemberRow | undefined;
  if (!row) throw new DomainError(404, 'not_found', 'unknown member');
  if (!row.revoked_at) {
    db.prepare('UPDATE memberships SET revoked_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      memberId,
    );
  }
  return memberFromRow(db.prepare('SELECT * FROM memberships WHERE id = ?').get(memberId) as unknown as MemberRow);
}

export function revokeInvitation(db: DatabaseSync, roomId: string, invitationId: string): Invitation {
  const row = db
    .prepare('SELECT * FROM invitations WHERE id = ? AND room_id = ?')
    .get(invitationId, roomId) as unknown as InvitationRow | undefined;
  if (!row) throw new DomainError(404, 'not_found', 'unknown invitation');
  if (!row.revoked_at && !row.used_at) {
    db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      invitationId,
    );
  }
  return invitationFromRow(
    db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId) as unknown as InvitationRow,
  );
}

export interface Roster {
  members: (Member & { status: 'active' | 'revoked' })[];
  openInvitations: { id: string; role: Role; name: string | null; expiresAt: string }[];
}

/** Roster for a room: active and revoked members plus still-usable invites. */
export function roomRoster(db: DatabaseSync, roomId: string): Roster {
  const memberRows = db
    .prepare('SELECT * FROM memberships WHERE room_id = ? ORDER BY created_at')
    .all(roomId) as unknown as MemberRow[];
  const inviteRows = db
    .prepare(
      `SELECT * FROM invitations WHERE room_id = ? AND used_at IS NULL AND revoked_at IS NULL
       ORDER BY created_at`,
    )
    .all(roomId) as unknown as InvitationRow[];
  const now = new Date().toISOString();
  return {
    members: memberRows.map((r) => ({
      ...memberFromRow(r),
      status: r.revoked_at ? ('revoked' as const) : ('active' as const),
    })),
    openInvitations: inviteRows
      .filter((r) => r.expires_at > now)
      .map((r) => ({ id: r.id, role: r.role as Role, name: r.name, expiresAt: r.expires_at })),
  };
}
