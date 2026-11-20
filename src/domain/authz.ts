import type { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../util/crypto.js';
import { memberBySession } from './rooms.js';
import type { Take } from './takes.js';

/**
 * Read authorization. Private production material (scripts, rooms, take
 * logs, replays) is readable by the production owner or by a live member of
 * a room in that production. Productions flagged `is_demo` are the only
 * assets readable without credentials — that is the explicit public path
 * used for judge demos.
 */
export function canReadProduction(
  db: DatabaseSync,
  productionId: string,
  token: string | null,
): boolean {
  const prod = db
    .prepare('SELECT is_demo, owner_token_hash FROM productions WHERE id = ?')
    .get(productionId) as { is_demo: number; owner_token_hash: string } | undefined;
  if (!prod) return false;
  if (prod.is_demo) return true;
  if (!token) return false;
  if (prod.owner_token_hash === sha256(token)) return true;
  const member = memberBySession(db, token);
  if (!member) return false;
  const room = db
    .prepare('SELECT production_id FROM rooms WHERE id = ?')
    .get(member.roomId) as { production_id: string } | undefined;
  return room?.production_id === productionId;
}

export function canReadRoom(db: DatabaseSync, roomId: string, token: string | null): boolean {
  const room = db
    .prepare('SELECT production_id FROM rooms WHERE id = ?')
    .get(roomId) as { production_id: string } | undefined;
  if (!room) return false;
  if (canReadProduction(db, room.production_id, token)) return true;
  const member = memberBySession(db, token);
  return !!member && member.roomId === roomId;
}

export function canReadTake(db: DatabaseSync, take: Take, token: string | null): boolean {
  return canReadRoom(db, take.roomId, token);
}

/** Write authorization for room-scoped commands: a live membership only. */
export function requireMembership(
  db: DatabaseSync,
  token: string | null,
  roomId: string,
) {
  const member = memberBySession(db, token);
  if (!member || member.roomId !== roomId) return null;
  return member;
}
