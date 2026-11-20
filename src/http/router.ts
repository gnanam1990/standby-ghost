import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  rawBody: string;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }

  async dispatch(ctx: Ctx): Promise<boolean> {
    const url = new URL(ctx.req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== ctx.req.method) continue;
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let match = true;
      for (let i = 0; i < parts.length; i++) {
        const p = route.parts[i]!;
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]!);
        else if (p !== parts[i]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      ctx.params = params;
      ctx.query = url.searchParams;
      await route.handler(ctx);
      return true;
    }
    return false;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, {
    error: err.code,
    message: err.message,
    ...(err.details !== undefined ? { details: err.details } : {}),
  });
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}
