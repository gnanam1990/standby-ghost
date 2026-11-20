import { EventEmitter } from 'node:events';

export interface BusMessage {
  type: 'event' | 'roster' | 'take';
  roomId: string;
  takeId?: string;
  event?: unknown;
}

/**
 * In-process fan-out: HTTP routes publish accepted mutations; the WebSocket
 * layer replays them to every live socket in the room. Delivery is at-least-
 * once — clients deduplicate by (take, seq) and pull missing intervals via
 * GET /takes/:id/events?after=.
 */
export class RoomBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(msg: BusMessage): void {
    this.emitter.emit(`room:${msg.roomId}`, msg);
  }

  subscribe(roomId: string, fn: (msg: BusMessage) => void): () => void {
    const key = `room:${roomId}`;
    this.emitter.on(key, fn);
    return () => this.emitter.off(key, fn);
  }
}
