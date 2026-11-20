import type { DatabaseSync } from 'node:sqlite';
import { HttpError, Router, bearer, sendJson } from '../router.js';
import { memberBySession, roomRoster } from '../../domain/rooms.js';
import { canReadTake, requireMembership } from '../../domain/authz.js';
import { getTake } from '../../domain/takes.js';
import { applyCommand, foldTake, listEvents, loadCues, type CommandInput } from '../../domain/engine.js';
import type { RoomBus } from '../../bus.js';
import { getReplay } from '../../domain/replay.js';

export function registerRehearsalRoutes(router: Router, db: DatabaseSync, bus: RoomBus): void {
  router.add('POST', '/api/takes/:id/commands', (ctx) => {
    const take = getTake(db, ctx.params.id!);
    if (!take) throw new HttpError(404, 'not_found', 'unknown take');
    const member = requireMembership(db, bearer(ctx.req), take.roomId);
    if (!member) {
      throw new HttpError(403, 'forbidden', 'a live role session is required');
    }
    const body = (ctx.body ?? {}) as CommandInput;
    const result = applyCommand(db, take.id, member, {
      commandId: String(body.commandId ?? ''),
      epoch: Number(body.epoch),
      ...(body.expectedSeq === undefined ? {} : { expectedSeq: Number(body.expectedSeq) }),
      ...(body.cueId === undefined ? {} : { cueId: String(body.cueId) }),
      kind: body.kind,
      payload: (body.payload ?? {}) as Record<string, unknown>,
    });
    if (!result.replayed) {
      bus.publish({ type: 'event', roomId: take.roomId, takeId: take.id, event: result.event });
    }
    sendJson(ctx.res, result.status, {
      event: result.event,
      replayed: result.replayed,
    });
  });

  // Catch-up cursor: clients request events strictly after their last seq.
  router.add('GET', '/api/takes/:id/events', (ctx) => {
    const take = getTake(db, ctx.params.id!);
    if (!take) throw new HttpError(404, 'not_found', 'unknown take');
    if (!canReadTake(db, take, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner or authorized room role required');
    }
    const after = Math.max(0, Number(ctx.query.get('after') ?? 0) || 0);
    sendJson(ctx.res, 200, {
      take: {
        id: take.id,
        status: take.status,
        epoch: take.epoch,
        nextSeq: take.nextSeq,
      },
      events: listEvents(db, take.id, after),
    });
  });

  // Ghost replay: planned vs observed path + first evidenced divergence.
  router.add('GET', '/api/takes/:id/replay', (ctx) => {
    const take = getTake(db, ctx.params.id!);
    if (!take) throw new HttpError(404, 'not_found', 'unknown take');
    if (!canReadTake(db, take, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner or authorized room role required');
    }
    sendJson(ctx.res, 200, { replay: getReplay(db, take.id) });
  });

  // Side-by-side comparison of two takes in the same room — e.g. the
  // original take and the corrected second take (FR-12).
  router.add('GET', '/api/takes/:id/compare', (ctx) => {
    const a = getTake(db, ctx.params.id!);
    if (!a) throw new HttpError(404, 'not_found', 'unknown take');
    const otherId = ctx.query.get('other');
    const b = otherId ? getTake(db, otherId) : null;
    if (!b || b.roomId !== a.roomId) {
      throw new HttpError(422, 'invalid_input', 'other must be a take in the same room');
    }
    if (!canReadTake(db, a, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner or authorized room role required');
    }
    const ra = getReplay(db, a.id);
    const rb = getReplay(db, b.id);
    const summarize = (t: typeof a, r: typeof ra) => ({
      takeId: t.id,
      scriptRevisionId: t.scriptRevisionId,
      status: t.status,
      epoch: t.epoch,
      eventCount: r.events.length,
      observedCount: r.observed.length,
      unresolvedCount: r.unresolved.length,
      firstDivergence: r.firstDivergence,
    });
    sendJson(ctx.res, 200, {
      a: summarize(a, ra),
      b: summarize(b, rb),
      replayA: ra,
      replayB: rb,
    });
  });

  // Materialized room state from a fresh fold of the durable log.
  router.add('GET', '/api/takes/:id/snapshot', (ctx) => {
    const take = getTake(db, ctx.params.id!);
    if (!take) throw new HttpError(404, 'not_found', 'unknown take');
    const member = memberBySession(db, bearer(ctx.req));
    if (!canReadTake(db, take, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner or authorized room role required');
    }
    const cues = loadCues(db, take.scriptRevisionId);
    const { cueStates, status, epoch } = foldTake(cues, listEvents(db, take.id));
    sendJson(ctx.res, 200, {
      take: { ...take, status, epoch },
      cues: cues.map((c) => ({
        ...c,
        state: cueStates[c.id],
      })),
      roster: roomRoster(db, take.roomId),
      me: member,
    });
  });
}
