import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { HttpError, readBody, Router, sendError, sendJson } from './router.js';
import { registerScriptRoutes } from './routes/scripts.js';
import { registerRoomRoutes } from './routes/rooms.js';
import { registerRehearsalRoutes } from './routes/rehearsal.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

export interface ServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

function serveStatic(staticDir: string, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  // /join/<token> serves the join page; the token stays out of query logs
  if (rel.startsWith('/join/')) rel = '/join.html';
  const file = path.normalize(path.join(staticDir, rel));
  if (!file.startsWith(path.normalize(staticDir + path.sep)) && file !== path.normalize(staticDir)) {
    return false;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
  return true;
}

export async function startServer(
  config: AppConfig,
  db: DatabaseSync,
): Promise<ServerHandle> {
  const router = new Router();
  registerScriptRoutes(router, db);
  registerRoomRoutes(router, db);
  registerRehearsalRoutes(router, db);

  const server = http.createServer(async (req, res) => {
    try {
      const rawBody = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
      let body: unknown = null;
      const ctype = req.headers['content-type'] ?? '';
      if (rawBody && ctype.includes('application/json')) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
        }
      } else if (rawBody) {
        body = rawBody;
      }
      const handled = await router.dispatch({
        req,
        res,
        params: {},
        query: new URLSearchParams(),
        body,
        rawBody,
      });
      if (!handled && !serveStatic(config.staticDir, req, res)) {
        if (!res.writableEnded) sendJson(res, 404, { error: 'not_found', message: 'no such route' });
      }
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpError) sendError(res, err);
      else if (err instanceof Error && 'status' in err && 'code' in err) {
        const e = err as { status: number; code: string; message: string; details?: unknown };
        sendError(res, new HttpError(e.status, e.code, e.message, e.details));
      }
      else {
        console.error('[server] unhandled error', err);
        sendJson(res, 500, { error: 'internal', message: 'internal server error' });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  return {
    server,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
