import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';
import { memberBySession } from './domain/rooms.js';
import { getTake } from './domain/takes.js';
import { listEvents } from './domain/engine.js';
import type { RoomBus } from './bus.js';

interface ClientHello {
  id: string;
  roomId: string;
  role: string;
  name: string;
}

/**
 * /ws?session=<token> — one socket per member session. Messages:
 *   server→client: hello {member}, event {takeId,event}, roster {roomId}, take {takeId}
 *   client→server: subscribe {takeId, after}  (catch-up reply: events [])
 */
export function attachWebSocket(server: Server, db: DatabaseSync, bus: RoomBus): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('session');
    const member = memberBySession(db, token);
    if (!member) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, member);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: unknown, member: ClientHello & { roomId: string }) => {
    const send = (msg: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const unsubscribe = bus.subscribe(member.roomId, send);
    send({ type: 'hello', member });

    ws.on('message', (raw) => {
      // A session revoked mid-connection (operator replaced) is dead even on
      // its still-open socket — re-check liveness on every message (NFR-01,
      // T-013).
      const live = db
        .prepare('SELECT 1 AS ok FROM memberships WHERE id = ? AND revoked_at IS NULL')
        .get(member.id) as { ok: number } | undefined;
      if (!live) {
        send({ type: 'error', code: 'revoked', message: 'role session was replaced' });
        ws.close(4003, 'session revoked');
        unsubscribe();
        return;
      }
      let msg: { type?: string; takeId?: string; after?: number };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'subscribe' && typeof msg.takeId === 'string') {
        const take = getTake(db, msg.takeId);
        if (!take || take.roomId !== member.roomId) {
          send({ type: 'error', code: 'forbidden', message: 'cannot subscribe to that take' });
          return;
        }
        const events = listEvents(db, take.id, Math.max(0, Number(msg.after) || 0));
        send({ type: 'events', takeId: take.id, events, latestSeq: take.nextSeq, epoch: take.epoch, status: take.status });
      }
    });

    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  });
}
