import type { DatabaseSync } from 'node:sqlite';
import { HttpError, Router, bearer, sendJson } from '../router.js';
import {
  createProduction,
  getProduction,
  getRevision,
  importScript,
  isOwner,
  listProductions,
  listRevisions,
  revisionChanges,
} from '../../domain/store.js';
import { canReadProduction } from '../../domain/authz.js';
import { exportCsv, SCRIPT_SCHEMA_VERSION } from '../../domain/script.js';

function requireOwner(db: DatabaseSync, productionId: string, token: string | null): void {
  if (!isOwner(db, productionId, token)) {
    throw new HttpError(403, 'forbidden', 'owner credentials required');
  }
}

export function registerScriptRoutes(router: Router, db: DatabaseSync): void {
  router.add('POST', '/api/productions', (ctx) => {
    const body = (ctx.body ?? {}) as { name?: string; isDemo?: boolean };
    if (!body.name || typeof body.name !== 'string' || body.name.length > 120) {
      throw new HttpError(422, 'invalid_input', 'name is required (max 120 chars)');
    }
    const created = createProduction(db, body.name.trim(), !!body.isDemo);
    sendJson(ctx.res, 201, {
      id: created.id,
      name: created.name,
      isDemo: created.isDemo,
      ownerToken: created.ownerToken,
    });
  });

  // Public directory exposes only explicitly flagged demo productions.
  router.add('GET', '/api/productions', (ctx) => {
    sendJson(ctx.res, 200, { productions: listProductions(db, true) });
  });

  router.add('GET', '/api/productions/:id', (ctx) => {
    const prod = getProduction(db, ctx.params.id!);
    if (!prod) throw new HttpError(404, 'not_found', 'unknown production');
    if (!canReadProduction(db, prod.id, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner or authorized room role required');
    }
    sendJson(ctx.res, 200, {
      production: prod,
      revisions: listRevisions(db, prod.id).map((r) => ({
        id: r.id,
        seq: r.seq,
        title: r.title,
        digest: r.digest,
        parentId: r.parentId,
        createdAt: r.createdAt,
        cueCount: r.cues.length,
      })),
    });
  });

  // Import a UTF-8 CSV scene as a new immutable revision. Owner only.
  // clientRequestId makes revision creation retry-safe (T-012); a repeat
  // returns the already-recorded revision with existing: true.
  router.add('POST', '/api/productions/:id/scripts', (ctx) => {
    const prod = getProduction(db, ctx.params.id!);
    if (!prod) throw new HttpError(404, 'not_found', 'unknown production');
    requireOwner(db, prod.id, bearer(ctx.req));
    const body = (ctx.body ?? {}) as {
      csv?: string;
      title?: string;
      clientRequestId?: string;
      sourceTakeId?: string;
      approvalNote?: string;
    };
    if (typeof body.csv !== 'string' || body.csv.length === 0) {
      throw new HttpError(422, 'invalid_input', 'csv field is required');
    }
    if (body.csv.length > 256 * 1024) {
      throw new HttpError(422, 'invalid_input', 'csv exceeds 256 KiB');
    }
    if (body.clientRequestId !== undefined && (typeof body.clientRequestId !== 'string' || body.clientRequestId.length > 120)) {
      throw new HttpError(422, 'invalid_input', 'clientRequestId must be a string (max 120 chars)');
    }
    if (body.approvalNote !== undefined && (typeof body.approvalNote !== 'string' || body.approvalNote.length > 500)) {
      throw new HttpError(422, 'invalid_input', 'approvalNote must be a string (max 500 chars)');
    }
    if (body.sourceTakeId !== undefined) {
      const take = db
        .prepare(
          'SELECT t.id FROM takes t JOIN rooms r ON r.id = t.room_id WHERE t.id = ? AND r.production_id = ?',
        )
        .get(body.sourceTakeId, prod.id) as { id: string } | undefined;
      if (!take) throw new HttpError(422, 'invalid_input', 'sourceTakeId is not a take in this production');
    }
    const options = {
      ...(body.clientRequestId !== undefined ? { clientRequestId: body.clientRequestId } : {}),
      ...(body.sourceTakeId !== undefined ? { sourceTakeId: body.sourceTakeId } : {}),
      ...(body.approvalNote !== undefined ? { approvalNote: body.approvalNote.trim() } : {}),
    };
    const outcome = importScript(db, prod.id, body.csv, body.title?.trim() || 'Untitled scene', options);
    if (!outcome.ok) {
      throw new HttpError(422, 'script_rejected', 'script failed validation', {
        errors: outcome.errors,
      });
    }
    sendJson(ctx.res, outcome.existing ? 200 : 201, {
      revision: outcome.revision,
      existing: outcome.existing,
    });
  });

  router.add('GET', '/api/scripts/:id', (ctx) => {
    const rev = getRevision(db, ctx.params.id!);
    if (!rev) throw new HttpError(404, 'not_found', 'unknown script revision');
    if (!canReadProduction(db, rev.productionId, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner or authorized room role required');
    }
    sendJson(ctx.res, 200, {
      revision: rev,
      changes: revisionChanges(db, rev),
      schemaVersion: SCRIPT_SCHEMA_VERSION,
    });
  });

  router.add('GET', '/api/scripts/:id/export.csv', (ctx) => {
    const rev = getRevision(db, ctx.params.id!);
    if (!rev) throw new HttpError(404, 'not_found', 'unknown script revision');
    if (!canReadProduction(db, rev.productionId, bearer(ctx.req))) {
      throw new HttpError(403, 'forbidden', 'owner or authorized room role required');
    }
    const csv = exportCsv(rev.cues);
    ctx.res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${rev.id}-calling-sheet.csv"`,
      'x-schema-version': String(SCRIPT_SCHEMA_VERSION),
      'x-revision-digest': rev.digest,
    });
    ctx.res.end(csv);
  });
}
