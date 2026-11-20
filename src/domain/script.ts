import { sha256 } from '../util/crypto.js';

export const LANES = ['caller', 'stage', 'sound', 'lights'] as const;
export type Lane = (typeof LANES)[number];
export const TRIGGERS = ['human', 'caller'] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const MAX_ROWS = 200;
export const MAX_CUE_ID = 64;
export const MAX_LABEL = 200;
export const CUE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SCRIPT_SCHEMA_VERSION = 1;
export const CSV_HEADER = ['cue_id', 'lane', 'label', 'after', 'trigger'];

export interface CueDef {
  id: string;
  lane: Lane;
  label: string;
  /** Predecessor cue ids (the CSV "after" column), in declared order. */
  deps: string[];
  trigger: Trigger;
  /** Row order inside the revision; used for deterministic ordering. */
  position: number;
}

export interface ImportError {
  row: number; // 1-based line number in the submitted file
  field: string;
  message: string;
}

export type ParseResult =
  | { ok: true; rows: string[][] }
  | { ok: false; errors: ImportError[] };

/**
 * Minimal RFC-4180 CSV reader: commas, double quotes ("" escape) and
 * newlines inside quoted cells. Cue text is always treated as text.
 */
export function parseCsv(text: string): ParseResult {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  const errors: ImportError[] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let cellLine = 1;

  const pushCell = () => {
    row.push(cell);
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      cellLine = line;
    } else if (ch === ',') {
      pushCell();
    } else if (ch === '\n') {
      line++;
      pushRow();
    } else if (ch === '\r') {
      // tolerate CRLF; the following \n ends the row
    } else {
      cell += ch;
    }
  }
  if (inQuotes) {
    errors.push({ row: cellLine, field: 'csv', message: 'unterminated quoted cell' });
    return { ok: false, errors };
  }
  pushRow();
  // drop a trailing fully-empty row produced by a final newline
  while (rows.length && rows[rows.length - 1]!.every((c) => c.trim() === '')) {
    rows.pop();
  }
  return { ok: true, rows };
}

export interface ValidationResult {
  cues: CueDef[];
  errors: ImportError[];
}

/** Validate header, fields, referential integrity and acyclicity. */
export function validateScene(rows: string[][]): ValidationResult {
  const errors: ImportError[] = [];
  if (rows.length === 0) {
    return { cues: [], errors: [{ row: 1, field: 'csv', message: 'empty file' }] };
  }
  const header = rows[0]!.map((c) => c.trim().toLowerCase());
  if (CSV_HEADER.some((h, i) => header[i] !== h) || header.length !== CSV_HEADER.length) {
    return {
      cues: [],
      errors: [
        {
          row: 1,
          field: 'header',
          message: `expected header ${CSV_HEADER.join(',')}`,
        },
      ],
    };
  }
  const data = rows.slice(1);
  if (data.length === 0) {
    errors.push({ row: 2, field: 'csv', message: 'no cue rows' });
  }
  if (data.length > MAX_ROWS) {
    errors.push({ row: MAX_ROWS + 2, field: 'csv', message: `more than ${MAX_ROWS} cue rows` });
  }

  const cues: CueDef[] = [];
  const seen = new Map<string, number>();
  data.forEach((cols, idx) => {
    const rowNo = idx + 2;
    if (cols.length !== CSV_HEADER.length) {
      errors.push({
        row: rowNo,
        field: 'csv',
        message: `expected ${CSV_HEADER.length} fields, got ${cols.length}`,
      });
      return;
    }
    const [idRaw, laneRaw, labelRaw, afterRaw, triggerRaw] = cols as [
      string,
      string,
      string,
      string,
      string,
    ];
    const id = idRaw.trim();
    const lane = laneRaw.trim().toLowerCase();
    const label = labelRaw.trim();
    const after = afterRaw.trim();
    const trigger = triggerRaw.trim().toLowerCase();

    if (!id || id.length > MAX_CUE_ID || !CUE_ID_PATTERN.test(id)) {
      errors.push({
        row: rowNo,
        field: 'cue_id',
        message: 'required, max 64 chars, letters/digits/_/- only',
      });
    } else if (seen.has(id)) {
      errors.push({ row: rowNo, field: 'cue_id', message: `duplicate cue id (first seen row ${seen.get(id)})` });
    } else {
      seen.set(id, rowNo);
    }
    if (!LANES.includes(lane as Lane)) {
      errors.push({ row: rowNo, field: 'lane', message: `must be one of ${LANES.join('|')}` });
    }
    if (!label || label.length > MAX_LABEL) {
      errors.push({ row: rowNo, field: 'label', message: `required, max ${MAX_LABEL} chars` });
    }
    if (!TRIGGERS.includes(trigger as Trigger)) {
      errors.push({ row: rowNo, field: 'trigger', message: `must be one of ${TRIGGERS.join('|')}` });
    }
    const deps = after === '' || after === '-'
      ? []
      : after.split(';').map((d) => d.trim()).filter(Boolean);
    if (new Set(deps).size !== deps.length) {
      errors.push({ row: rowNo, field: 'after', message: 'duplicate predecessor' });
    }
    if (deps.includes(id)) {
      errors.push({ row: rowNo, field: 'after', message: 'cue cannot depend on itself' });
    }
    cues.push({ id, lane: lane as Lane, label, deps, trigger: trigger as Trigger, position: idx });
  });

  // referential integrity
  const ids = new Set(cues.map((c) => c.id));
  for (const cue of cues) {
    for (const dep of cue.deps) {
      if (!ids.has(dep)) {
        errors.push({
          row: cue.position + 2,
          field: 'after',
          message: `unknown predecessor "${dep}"`,
        });
      }
    }
  }

  // acyclicity (Kahn) — deterministic order by declared position
  if (errors.length === 0) {
    const order = topoOrder(cues);
    if (order.length !== cues.length) {
      const ordered = new Set(order);
      const inCycle = cues.filter((c) => !ordered.has(c.id));
      for (const cue of inCycle) {
        errors.push({
          row: cue.position + 2,
          field: 'after',
          message: `dependency cycle involving "${cue.id}"`,
        });
      }
    }
  }

  return { cues, errors };
}

/**
 * Deterministic topological order of cue ids: predecessors first, ties broken
 * by declared row position. Independent (parallel) cues keep input order.
 */
export function topoOrder(cues: CueDef[]): string[] {
  const byId = new Map(cues.map((c) => [c.id, c]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const c of cues) {
    indegree.set(c.id, c.deps.length);
    for (const d of c.deps) {
      const list = dependents.get(d) ?? [];
      list.push(c.id);
      dependents.set(d, list);
    }
  }
  const ready = cues.filter((c) => c.deps.length === 0).map((c) => c.id);
  const order: string[] = [];
  while (ready.length) {
    // smallest position first for determinism
    ready.sort((a, b) => byId.get(a)!.position - byId.get(b)!.position);
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const n = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, n);
      if (n === 0) ready.push(next);
    }
  }
  return order;
}

/** Canonical content digest: re-importing an export must reproduce it. */
export function digestCues(cues: CueDef[]): string {
  const lines = [...cues]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(
      (c) =>
        `${c.id}|${c.lane}|${c.label}|${[...c.deps].sort().join(';')}|${c.trigger}`,
    );
  return sha256(`sg-script-v${SCRIPT_SCHEMA_VERSION}\n${lines.join('\n')}`);
}

/** Spreadsheet-formula neutralization for exported cells. */
function neutralize(cell: string): string {
  if (/^[=+\-@]/.test(cell)) return `'${cell}`;
  return cell;
}

function csvCell(cell: string): string {
  const safe = neutralize(cell);
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Quote if needed, but never neutralize (structured columns like "after"). */
function csvRawCell(cell: string): string {
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/**
 * Export the printable calling order as CSV. Re-importing this output
 * preserves cue identities and the revision digest (T-001).
 */
export function exportCsv(cues: CueDef[]): string {
  const ordered = topoOrder(cues);
  const byId = new Map(cues.map((c) => [c.id, c]));
  const lines = [CSV_HEADER.join(',')];
  for (const id of ordered) {
    const c = byId.get(id)!;
    // the "-" sentinel means "no predecessor" and must not be neutralized
    const after = [...c.deps].sort().join(';') || '-';
    lines.push(
      [csvCell(c.id), csvCell(c.lane), csvCell(c.label), csvRawCell(after), csvCell(c.trigger)].join(','),
    );
  }
  return lines.join('\n') + '\n';
}
