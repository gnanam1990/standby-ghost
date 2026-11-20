import type { DatabaseSync } from 'node:sqlite';
import { HttpError, Router, bearer, sendJson } from '../router.js';
import { isOwner } from '../../domain/store.js';
import {
  createInvitation,
  createRoom,
  getRoom,
  joinRoom,
  memberBySession,
  revokeInvitation,
  revokeMember,
  roomRoster,
  type Role,
} from '../../domain/rooms.js';
import { createTake, getTake, listTakes } from '../../domain/takes.js';

function roomOr404(db: DatabaseSync, id: string) {
  const room = getRoom(db, id);
  if (!room) throw new HttpError(404, 'not_found', 'unknown room');
  return room;
}

/** Resolve the caller's session and assert room + optional role set. */
function requireMember(
  db: DatabaseSync,
  token: string | null,
  roomId: string,
  roles?: Role[],
) {
  const member = memberBySession(db, token);
  if (!member || member.roomId !== roomId) {
    throw new HttpError(403, 'forbidden', 'a live role session is required');
  }
  if (roles && !roles.includes(member.role)) {
    throw new HttpError(403, 'forbidden_role', `requires role: ${roles.join('|')}`);
  }
  return member;
}

export function registerRoomRoutes(router: Router, db: DatabaseSync): void {
  router.add('POST', '/api/productions/:id/rooms', (ctx) => {
    const productionId = ctx.params.id!;
    const room = (() => {
      const body = (ctx.body ?? {}) as { scriptRevisionId?: string; name?: string };
      if (!body.scriptRevisionId) {
        throw new HttpError(422, 'invalid_input', 'scriptRevisionId is required');
      }
      if (!isOwner(db, productionId, bearer(ctx.req))) {
        throw new HttpError(403, 'forbidden', 'owner credentials required');
      }
      return createRoom(db, productionId, body.scriptRevisionId, (body.name ?? 'Rehearsal room').trim());
    })();
    sendJson(ctx.res, 201, { room });
  });

  router.add('GET', '/api/rooms/:id', (ctx) => {
    const room = roomOr404(db, ctx.params.id!);
    const rev = db
      .prepare('SELECT id, seq, title, digest FROM script_revisions WHERE id = ?')
      .get(room.scriptRevisionId) as { id: string; seq: number; title: string; digest: string };
    const me = memberBySession(db, bearer(ctx.req));
    sendJson(ctx.res, 200, {
      room,
      scriptRevision: rev,
      roster: roomRoster(db, room.id),
      takes: listTakes(db, room.id),
      me: me && me.roomId === room.id ? me : null,
    });
  });

  router.add('GET', '/api/rooms/:id/roster', (ctx) => {
    const room = roomOr404(db, ctx.params.id!);
    sendJson(ctx.res, 200, { roster: roomRoster(db, room.id) });
  });

  router.add('POST', '/api/rooms/:id/invitations', (ctx) => {
    const room = roomOr404(db, ctx.params.id!);
    if (!isOwner(db, room.productionId, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner credentials required');
    }
    const body = (ctx.body ?? {}) as { role?: Role; name?: string; ttlMinutes?: number };
    if (!body.role) throw new HttpError(422, 'invalid_input', 'role is required');
    const { invitation, token } = createInvitation(
      db,
      room.id,
      body.role,
      body.name?.trim() || null,
      body.ttlMinutes ?? 60,
    );
    sendJson(ctx.res, 201, {
      invitation,
      token,
      joinUrl: `/join/${token}`,
    });
  });

  router.add('POST', '/api/rooms/:id/invitations/:invId/revoke', (ctx) => {
    const room = roomOr404(db, ctx.params.id!);
    if (!isOwner(db, room.productionId, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner credentials required');
    }
    sendJson(ctx.res, 200, { invitation: revokeInvitation(db, room.id, ctx.params.invId!) });
  });

  router.add('POST', '/api/rooms/:id/members/:memberId/revoke', (ctx) => {
    const room = roomOr404(db, ctx.params.id!);
    if (!isOwner(db, room.productionId, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner credentials required');
    }
    sendJson(ctx.res, 200, { member: revokeMember(db, room.id, ctx.params.memberId!) });
  });

  // Redeem an invitation link. Single use; the session token is the only
  // credential the client stores.
  router.add('POST', '/api/join', (ctx) => {
    const body = (ctx.body ?? {}) as { token?: string; name?: string };
    if (!body.token) throw new HttpError(422, 'invalid_input', 'token is required');
    const result = joinRoom(db, body.token, body.name?.trim() || null);
    if (!result.ok) {
      throw new HttpError(result.status, result.code, result.message);
    }
    sendJson(ctx.res, 201, {
      member: result.member,
      sessionToken: result.sessionToken,
      roomId: result.member.roomId,
    });
  });

  // Starting a take is the caller's first room-scoped command (FR-05+ uses
  // the commands endpoint on top of it). Caller role only.
  router.add('POST', '/api/rooms/:id/takes', (ctx) => {
    const room = roomOr404(db, ctx.params.id!);
    const member = requireMember(db, bearer(ctx.req), room.id, ['caller']);
    const take = createTake(db, room.id, room.scriptRevisionId, member);
    sendJson(ctx.res, 201, { take });
  });

  router.add('GET', '/api/takes/:id', (ctx) => {
    const take = getTake(db, ctx.params.id!);
    if (!take) throw new HttpError(404, 'not_found', 'unknown take');
    const me = memberBySession(db, bearer(ctx.req));
    sendJson(ctx.res, 200, { take, me: me && me.roomId === take.roomId ? me : null });
  });
}
