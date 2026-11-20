import type { DatabaseSync } from 'node:sqlite';
import { topoOrder, type CueDef } from './script.js';
import { listEvents, loadCues, type EventRecord } from './engine.js';
import { getTake } from './takes.js';
import { DomainError } from './rooms.js';

/**
 * What orders a cue on the *actual* timeline: the caller's authorized call
 * (GO), the caller's human observation (ENTRANCE), or a desk's testimony of
 * physical execution (OBSERVED_GO). Standbys and acks are intent, not
 * execution. OBSERVED_GO never moves the playhead — it only orders the cue
 * on the observed path at its recorded sequence.
 */
const EXECUTION_KINDS = new Set(['GO', 'ENTRANCE', 'OBSERVED_GO']);

export interface ObservedStep {
  seq: number;
  cueId: string;
  kind: 'GO' | 'ENTRANCE' | 'OBSERVED_GO';
  actorName: string;
  actorRole: string;
  /** desk-reported stage time when provided; 'unknown' when absent (T-010). */
  observedAt: string;
  receivedAt: string;
}

export type DivergenceReason =
  | 'no_preceding_signal'
  | 'skipped_predecessor';

export interface Divergence {
  seq: number;
  cueId: string;
  actorName: string;
  actorRole: string;
  /** The violated required edge: `from` (predecessor) → `to` (cue). */
  violatedEdge: { from: string; to: string };
  reason: DivergenceReason;
  /** Plain-language explanation for assistive tech and the text table. */
  explanation: string;
  /** Alternatives / evidence gaps the crew should check. */
  observationGaps: string[];
}

export interface UnresolvedOutcome {
  cueId: string;
  lane: string;
  state: 'expected_not_observed' | 'called_not_observed' | 'not_executed';
  detail: string;
}

export interface ReplayResult {
  takeId: string;
  scriptRevisionId: string;
  status: string;
  epoch: number;
  expectedOrder: string[];
  /** cueId → lane, for display independent of who reported the event. */
  lanes: Record<string, string>;
  observed: ObservedStep[];
  firstDivergence: Divergence | null;
  unresolved: UnresolvedOutcome[];
  events: EventRecord[];
}

interface SkipInfo {
  seq: number;
  path: 'allow' | 'block';
}

/**
 * Reconstruct the planned-vs-observed cue path from the durable event log and
 * locate the first *evidenced* divergence (FR-09).
 *
 * For each execution event in sequence order, every declared predecessor edge
 * must be observably resolved by an earlier execution event, or by an
 * explicit skip recorded with `path: "allow"`. A skip with `path: "block"`
 * leaves dependents illegal until a resume re-opens them — an execution seen
 * anyway is itself a divergence. Independent parallel cues have no edge
 * between them, so legal swaps never flag (T-009).
 */
export function computeReplay(
  cues: CueDef[],
  events: EventRecord[],
  takeId: string,
  scriptRevisionId: string,
  status: string,
  epoch: number,
): ReplayResult {
  const byId = new Map(cues.map((c) => [c.id, c]));
  const skips = new Map<string, SkipInfo>();
  const executedAt = new Map<string, number>();
  const observed: ObservedStep[] = [];
  let firstDivergence: Divergence | null = null;

  const edgeStatus = (
    pred: string,
    seq: number,
  ): 'resolved' | 'blocked' | 'allowed' | 'unresolved' => {
    const skip = skips.get(pred);
    const exec = executedAt.get(pred);
    if (exec !== undefined && exec < seq) return 'resolved';
    if (skip !== undefined && skip.seq < seq) {
      return skip.path === 'allow' ? 'allowed' : 'blocked';
    }
    return 'unresolved';
  };

  for (const e of events) {
    if (e.kind === 'SKIP' && e.cueId) {
      skips.set(e.cueId, {
        seq: e.seq,
        path: e.payload.path === 'allow' ? 'allow' : 'block',
      });
      continue;
    }
    if (!EXECUTION_KINDS.has(e.kind) || !e.cueId) continue;

    observed.push({
      seq: e.seq,
      cueId: e.cueId,
      kind: e.kind as ObservedStep['kind'],
      actorName: e.actorName,
      actorRole: e.actorRole,
      observedAt: typeof e.payload.observedAt === 'string' ? e.payload.observedAt : 'unknown',
      receivedAt: e.createdAt,
    });

    const cue = byId.get(e.cueId);
    if (cue && !firstDivergence) {
      for (const pred of cue.deps) {
        const statusAt = edgeStatus(pred, e.seq);
        if (statusAt === 'resolved' || statusAt === 'allowed') continue;
        const gaps: string[] = [];
        const predExec = executedAt.get(pred);
        const predSkip = skips.get(pred);
        if (statusAt === 'blocked') {
          gaps.push(
            `${pred} was explicitly skipped at seq ${predSkip!.seq} with dependents blocked — a crew decision is needed before ${cue.id} may run`,
          );
        } else {
          gaps.push(`${pred}: no preceding signal recorded`);
        }
        if (predExec !== undefined && predExec >= e.seq) {
          gaps.push(`${pred} was only recorded later at seq ${predExec}`);
        }
        for (const other of cue.deps) {
          if (other !== pred && executedAt.get(other) === undefined && edgeStatus(other, e.seq) === 'unresolved') {
            gaps.push(`${other}: also unresolved at this point`);
          }
        }
        firstDivergence = {
          seq: e.seq,
          cueId: e.cueId,
          actorName: e.actorName,
          actorRole: e.actorRole,
          violatedEdge: { from: pred, to: cue.id },
          reason: statusAt === 'blocked' ? 'skipped_predecessor' : 'no_preceding_signal',
          explanation:
            `${e.cueId} (${cue.lane}, reported by ${e.actorName}/${e.actorRole} at seq ${e.seq}) ` +
            `preceded its required predecessor ${pred}: ` +
            (statusAt === 'blocked'
              ? `${pred} was skipped with its dependent path blocked`
              : 'no preceding signal recorded'),
          observationGaps: gaps,
        };
        break; // only the earliest violated edge counts
      }
    }
    if (!executedAt.has(e.cueId)) executedAt.set(e.cueId, e.seq);
  }

  // unobserved outcomes: intent without execution evidence (INV-05 — an
  // absent observation is not proof of physical failure)
  const calledOrStandby = new Map<string, { kind: string; seq: number }>();
  for (const e of events) {
    if (!e.cueId) continue;
    if (e.kind === 'STANDBY' && !calledOrStandby.has(e.cueId)) {
      calledOrStandby.set(e.cueId, { kind: 'STANDBY', seq: e.seq });
    }
    if (e.kind === 'GO') calledOrStandby.set(e.cueId, { kind: 'GO', seq: e.seq });
  }
  const unresolved: UnresolvedOutcome[] = [];
  for (const cue of cues) {
    const exec = executedAt.get(cue.id);
    const skip = skips.get(cue.id);
    if (skip) continue;
    if (exec === undefined) {
      const intent = calledOrStandby.get(cue.id);
      if (intent) {
        unresolved.push({
          cueId: cue.id,
          lane: cue.lane,
          state: cue.trigger === 'human' ? 'expected_not_observed' : 'called_not_observed',
          detail:
            cue.trigger === 'human'
              ? `${cue.id} was expected (${intent.kind.toLowerCase()} at seq ${intent.seq}) but no human observation was recorded — what happened on stage is unknown`
              : `${cue.id} was ${intent.kind === 'GO' ? 'called' : 'placed on standby'} at seq ${intent.seq} but no execution signal was recorded`,
        });
      }
    } else {
      const intent = calledOrStandby.get(cue.id);
      if (intent?.kind === 'GO') {
        const hasTestimony = events.some(
          (e) => e.cueId === cue.id && (e.kind === 'OBSERVED_GO' || e.kind === 'ENTRANCE'),
        );
        if (!hasTestimony) {
          unresolved.push({
            cueId: cue.id,
            lane: cue.lane,
            state: 'called_not_observed',
            detail: `${cue.id} was called at seq ${intent.seq} but no desk observation confirms it fired`,
          });
        }
      }
    }
  }

  return {
    takeId,
    scriptRevisionId,
    status,
    epoch,
    expectedOrder: topoOrder(cues),
    lanes: Object.fromEntries(cues.map((c) => [c.id, c.lane])),
    observed,
    firstDivergence,
    unresolved,
    events,
  };
}

export function getReplay(db: DatabaseSync, takeId: string): ReplayResult {
  const take = getTake(db, takeId);
  if (!take) throw new DomainError(404, 'not_found', 'unknown take');
  const cues = loadCues(db, take.scriptRevisionId);
  return computeReplay(
    cues,
    listEvents(db, takeId),
    take.id,
    take.scriptRevisionId,
    take.status,
    take.epoch,
  );
}
