import type { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../util/crypto.js';
import { withTransaction } from '../db/database.js';
import { DomainError, type Member } from './rooms.js';
import { takeFromRow, type Take, type TakeRow } from './takes.js';
import type { CueDef } from './script.js';

export const COMMAND_KINDS = [
  'STANDBY',
  'ACK',
  'ENTRANCE',
  'GO',
  'OBSERVED_GO',
  'HOLD',
  'SKIP',
  'RESUME',
  'FINISH',
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** Commands that drive the playhead — caller only. */
const CALLER_COMMANDS: CommandKind[] = [
  'STANDBY',
  'ENTRANCE',
  'GO',
  'HOLD',
  'SKIP',
  'RESUME',
  'FINISH',
];
const CUE_COMMANDS: CommandKind[] = ['STANDBY', 'ACK', 'ENTRANCE', 'GO', 'OBSERVED_GO', 'SKIP'];

export interface CommandInput {
  commandId: string;
  epoch: number;
  expectedSeq?: number;
  cueId?: string;
  kind: CommandKind;
  payload?: Record<string, unknown>;
}

export type CueStateName =
  | 'waiting'
  | 'standby'
  | 'acknowledged'
  | 'called'
  | 'observed'
  | 'skipped';

export interface CueState {
  state: CueStateName;
  /** seq of the event that put the cue in this state. */
  sinceSeq: number;
  /** for skipped cues: whether dependents may still run. */
  pathChoice?: 'allow' | 'block';
}

export interface EventRecord {
  takeId: string;
  seq: number;
  epoch: number;
  commandId: string;
  memberId: string;
  actorName: string;
  actorRole: string;
  cueId: string | null;
  kind: CommandKind;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface EventRow {
  take_id: string;
  seq: number;
  epoch: number;
  command_id: string;
  member_id: string;
  cue_id: string | null;
  kind: string;
  payload_json: string;
  created_at: string;
  actor_name: string;
  actor_role: string;
}

function eventFromRow(r: EventRow): EventRecord {
  return {
    takeId: r.take_id,
    seq: r.seq,
    epoch: r.epoch,
    commandId: r.command_id,
    memberId: r.member_id,
    actorName: r.actor_name,
    actorRole: r.actor_role,
    cueId: r.cue_id,
    kind: r.kind as CommandKind,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

const EVENT_SELECT = `
  SELECT e.*, m.name AS actor_name, m.role AS actor_role
  FROM events e JOIN memberships m ON m.id = e.member_id
`;

export function listEvents(db: DatabaseSync, takeId: string, after = 0): EventRecord[] {
  const rows = db
    .prepare(`${EVENT_SELECT} WHERE e.take_id = ? AND e.seq > ? ORDER BY e.seq`)
    .all(takeId, after) as unknown as EventRow[];
  return rows.map(eventFromRow);
}

export function loadCues(db: DatabaseSync, revisionId: string): CueDef[] {
  const rows = db
    .prepare('SELECT * FROM cues WHERE revision_id = ? ORDER BY position')
    .all(revisionId) as unknown as {
    cue_id: string;
    lane: string;
    label: string;
    deps_json: string;
    trigger_kind: string;
    position: number;
  }[];
  return rows.map((r) => ({
    id: r.cue_id,
    lane: r.lane as CueDef['lane'],
    label: r.label,
    deps: JSON.parse(r.deps_json) as string[],
    trigger: r.trigger_kind as CueDef['trigger'],
    position: r.position,
  }));
}

/**
 * Fold the durable event log into cue/transport state. Pure and deterministic:
 * the snapshot endpoint, the command preconditions and the replay reducer all
 * consume the same fold.
 */
export function foldTake(cues: CueDef[], events: EventRecord[]): {
  cueStates: Record<string, CueState>;
  status: Take['status'];
  epoch: number;
} {
  const cueStates: Record<string, CueState> = {};
  for (const c of cues) cueStates[c.id] = { state: 'waiting', sinceSeq: 0 };
  let status: Take['status'] = 'active';
  let epoch = 1;
  for (const e of events) {
    epoch = Math.max(epoch, e.epoch);
    const cue = e.cueId ? cueStates[e.cueId] : undefined;
    switch (e.kind) {
      case 'STANDBY':
        if (cue) cueStates[e.cueId!] = { state: 'standby', sinceSeq: e.seq };
        break;
      case 'ACK':
        if (cue) cueStates[e.cueId!] = { state: 'acknowledged', sinceSeq: e.seq };
        break;
      case 'ENTRANCE':
        if (cue) cueStates[e.cueId!] = { state: 'observed', sinceSeq: e.seq };
        break;
      case 'GO':
        if (cue) cueStates[e.cueId!] = { state: 'called', sinceSeq: e.seq };
        break;
      case 'SKIP':
        if (cue) {
          cueStates[e.cueId!] = {
            state: 'skipped',
            sinceSeq: e.seq,
            pathChoice: e.payload.path === 'allow' ? 'allow' : 'block',
          };
        }
        break;
      case 'HOLD':
        status = 'held';
        break;
      case 'RESUME': {
        status = 'active';
        epoch = e.epoch;
        // a new epoch invalidates pending standbys: desks must re-acknowledge
        for (const [id, s] of Object.entries(cueStates)) {
          if (s.state === 'standby' || s.state === 'acknowledged') {
            cueStates[id] = { state: 'waiting', sinceSeq: e.seq };
          }
        }
        const dest = String(e.payload.destination ?? '');
        if (dest && cueStates[dest]) {
          cueStates[dest] = { state: 'standby', sinceSeq: e.seq };
        }
        break;
      }
      case 'FINISH':
        status = 'sealed';
        break;
      case 'OBSERVED_GO':
        // testimony only — never moves the playhead
        break;
    }
  }
  return { cueStates, status, epoch };
}

/** Every declared predecessor observably resolved (engine view). */
export function depsSatisfied(cue: CueDef, cueStates: Record<string, CueState>): boolean {
  return cue.deps.every((d) => {
    const s = cueStates[d];
    if (!s) return false;
    if (s.state === 'observed' || s.state === 'called') return true;
    if (s.state === 'skipped' && s.pathChoice === 'allow') return true;
    return false;
  });
}

function fingerprint(cmd: CommandInput): string {
  return sha256(
    JSON.stringify({
      kind: cmd.kind,
      cueId: cmd.cueId ?? null,
      payload: cmd.payload ?? {},
    }),
  );
}

function reject(status: number, code: string, message: string, details?: unknown): never {
  throw new DomainError(status, code, message, details);
}

export type CommandResult = { status: 200 | 201; event: EventRecord; replayed: boolean };

/**
 * Append one command to a take. Authorization first, then idempotent retry,
 * epoch, optimistic sequence, then the transition table — all inside one
 * transaction, so every accepted command id contributes at most one event
 * (INV-03) and stale epochs/generations cannot move live state (NFR-01).
 */
export function applyCommand(
  db: DatabaseSync,
  takeId: string,
  member: Member,
  cmd: CommandInput,
): CommandResult {
  if (!COMMAND_KINDS.includes(cmd.kind)) {
    reject(422, 'invalid_input', `kind must be one of ${COMMAND_KINDS.join('|')}`);
  }
  if (!cmd.commandId || cmd.commandId.length > 128) {
    reject(422, 'invalid_input', 'commandId is required (max 128 chars)');
  }
  if (CUE_COMMANDS.includes(cmd.kind) && !cmd.cueId) {
    reject(422, 'invalid_input', `cueId is required for ${cmd.kind}`);
  }

  return withTransaction(db, () => {
    const takeRow = db.prepare('SELECT * FROM takes WHERE id = ?').get(takeId) as
      | TakeRow
      | undefined;
    if (!takeRow) reject(404, 'not_found', 'unknown take');
    const take = takeFromRow(takeRow);
    if (member.roomId !== take.roomId) reject(403, 'forbidden', 'not a member of this room');
    const cues = loadCues(db, take.scriptRevisionId);
    const cue = cmd.cueId ? cues.find((c) => c.id === cmd.cueId) : undefined;
    if (cmd.cueId && !cue) reject(422, 'invalid_input', `unknown cue "${cmd.cueId}"`);

    // --- authorize the actor first ------------------------------------
    if (CALLER_COMMANDS.includes(cmd.kind) && member.role !== 'caller') {
      reject(403, 'forbidden_role', `${cmd.kind} requires the caller`);
    }
    if ((cmd.kind === 'ACK' || cmd.kind === 'OBSERVED_GO') && member.role !== cue!.lane) {
      reject(403, 'forbidden_role', `${cmd.kind} for lane ${cue!.lane} requires a ${cue!.lane} desk`);
    }

    // --- idempotent retry ----------------------------------------------
    const existing = db
      .prepare(
        `${EVENT_SELECT} WHERE e.take_id = ? AND e.member_id = ? AND e.command_id = ?`,
      )
      .get(takeId, member.id, cmd.commandId) as EventRow | undefined;
    const fp = fingerprint(cmd);
    if (existing) {
      const original = eventFromRow(existing);
      const originalFp = sha256(
        JSON.stringify({
          kind: original.kind,
          cueId: original.cueId,
          payload: original.payload,
        }),
      );
      if (originalFp !== fp) {
        reject(409, 'command_conflict', 'commandId was already used with different content', {
          original,
        });
      }
      return { status: 200 as const, event: original, replayed: true };
    }

    // --- freshness ------------------------------------------------------
    if (cmd.epoch !== take.epoch) {
      reject(409, 'stale_epoch', `take is at epoch ${take.epoch}`, {
        epoch: take.epoch,
        latestSeq: take.nextSeq,
      });
    }
    if (cmd.expectedSeq !== undefined && cmd.expectedSeq !== take.nextSeq) {
      reject(409, 'stale_seq', `latest sequence is ${take.nextSeq}`, {
        latestSeq: take.nextSeq,
      });
    }

    // --- transition table ------------------------------------------------
    if (take.status === 'sealed') {
      reject(409, 'sealed', 'take is sealed; start a new take on a new revision');
    }
    const events = listEvents(db, takeId);
    const { cueStates } = foldTake(cues, events);
    const cueState = cue ? cueStates[cue.id]! : undefined;

    if (take.status === 'held' && !['SKIP', 'RESUME', 'OBSERVED_GO'].includes(cmd.kind)) {
      reject(409, 'held', 'take is held; SKIP, RESUME or OBSERVED_GO only');
    }

    const require = (cond: boolean, code: string, message: string) => {
      if (!cond) reject(409, code, message);
    };
    const payload = cmd.payload ?? {};

    switch (cmd.kind) {
      case 'STANDBY':
        require(cueState!.state === 'waiting', 'bad_transition', `${cue!.id} is ${cueState!.state}, cannot standby`);
        require(depsSatisfied(cue!, cueStates), 'bad_transition', `${cue!.id} predecessors are not resolved`);
        break;
      case 'ACK':
        require(cueState!.state === 'standby', 'bad_transition', `${cue!.id} is not on standby`);
        break;
      case 'ENTRANCE':
        require(cue!.trigger === 'human', 'bad_transition', `${cue!.id} is not a human-trigger cue`);
        require(cueState!.state === 'standby', 'bad_transition', `${cue!.id} is not on standby`);
        break;
      case 'GO':
        require(cue!.trigger === 'caller', 'bad_transition', `${cue!.id} is a human-trigger cue; use ENTRANCE`);
        require(
          cueState!.state === 'standby' || cueState!.state === 'acknowledged',
          'bad_transition',
          `${cue!.id} is ${cueState!.state}, cannot call GO`,
        );
        require(depsSatisfied(cue!, cueStates), 'bad_transition', `${cue!.id} predecessors are not resolved`);
        break;
      case 'OBSERVED_GO':
        // testimony: any live state; lane authorization already checked
        break;
      case 'HOLD':
        require(take.status === 'active', 'bad_transition', 'take is not active');
        require(typeof payload.reason === 'string' && payload.reason.trim().length > 0, 'invalid_input', 'HOLD requires a reason');
        break;
      case 'SKIP':
        require(take.status === 'held', 'bad_transition', 'take must be held to SKIP');
        require(typeof payload.reason === 'string' && payload.reason.trim().length > 0, 'invalid_input', 'SKIP requires a reason');
        require(
          payload.path === 'allow' || payload.path === 'block',
          'invalid_input',
          'SKIP requires an explicit affected-path choice: "allow" or "block"',
        );
        require(
          cueState!.state !== 'called' && cueState!.state !== 'observed',
          'bad_transition',
          `${cue!.id} already ran (${cueState!.state})`,
        );
        break;
      case 'RESUME': {
        require(take.status === 'held', 'bad_transition', 'take must be held to RESUME');
        const dest = String(payload.destination ?? '');
        require(!!dest, 'invalid_input', 'RESUME requires a destination cue');
        const destCue = cues.find((c) => c.id === dest);
        require(!!destCue, 'invalid_input', `unknown resume destination "${dest}"`);
        require(typeof payload.reason === 'string' && payload.reason.trim().length > 0, 'invalid_input', 'RESUME requires a reason');
        const destState = cueStates[dest]!;
        require(
          destState.state === 'waiting' || destState.state === 'standby' || destState.state === 'acknowledged',
          'bad_transition',
          `${dest} already ran (${destState.state})`,
        );
        break;
      }
      case 'FINISH':
        break;
    }

    const nextStatus = cmd.kind === 'HOLD' ? 'held' : cmd.kind === 'RESUME' ? 'active' : cmd.kind === 'FINISH' ? 'sealed' : take.status;
    const nextEpoch = cmd.kind === 'RESUME' ? take.epoch + 1 : take.epoch;
    const seq = take.nextSeq;
    db.prepare(
      `INSERT INTO events (take_id, seq, epoch, command_id, member_id, cue_id, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      takeId,
      seq,
      nextEpoch,
      cmd.commandId,
      member.id,
      cmd.cueId ?? null,
      cmd.kind,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
    db.prepare('UPDATE takes SET next_seq = ?, status = ?, epoch = ?, sealed_at = ? WHERE id = ?').run(
      seq + 1,
      nextStatus,
      nextEpoch,
      nextStatus === 'sealed' ? new Date().toISOString() : take.sealedAt,
      takeId,
    );
    const row = db
      .prepare(`${EVENT_SELECT} WHERE e.take_id = ? AND e.seq = ?`)
      .get(takeId, seq) as unknown as EventRow;
    return { status: 201 as const, event: eventFromRow(row), replayed: false };
  });
}
