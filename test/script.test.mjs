import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv,
  validateScene,
  topoOrder,
  digestCues,
  exportCsv,
} from '../dist/domain/script.js';

const HEADER = 'cue_id,lane,label,after,trigger';

test('parseCsv handles quotes, commas and CRLF', () => {
  const { ok, rows } = parseCsv(`${HEADER}\r\nE1,stage,"Mira enters, late",-,human\r\n`);
  assert.equal(ok, true);
  assert.equal(rows[1][2], 'Mira enters, late');
});

test('validateScene rejects unknown predecessor with row detail', () => {
  const { errors } = validateScene([
    HEADER.split(','),
    ['S1', 'sound', 'chime', 'NOPE', 'caller'],
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].row, 2);
  assert.equal(errors[0].field, 'after');
  assert.match(errors[0].message, /unknown predecessor "NOPE"/);
});

test('validateScene rejects cycles', () => {
  const { errors } = validateScene([
    HEADER.split(','),
    ['A', 'sound', 'a', 'B', 'caller'],
    ['B', 'sound', 'b', 'A', 'caller'],
  ]);
  assert.ok(errors.some((e) => /cycle/.test(e.message)));
});

test('validateScene rejects duplicate ids and bad lanes', () => {
  const { errors } = validateScene([
    HEADER.split(','),
    ['A', 'sound', 'a', '-', 'caller'],
    ['A', 'pyro', 'b', '-', 'caller'],
  ]);
  assert.ok(errors.some((e) => /duplicate cue id/.test(e.message)));
  assert.ok(errors.some((e) => e.field === 'lane'));
});

test('topoOrder is deterministic and keeps parallel order', () => {
  const { cues, errors } = validateScene([
    HEADER.split(','),
    ['E1', 'stage', 'enter', '-', 'human'],
    ['S1', 'sound', 'chime', 'E1', 'caller'],
    ['L1', 'lights', 'warm', 'S1', 'caller'],
    ['L2', 'lights', 'side', 'L1', 'caller'],
    ['S2', 'sound', 'swell', 'L1', 'caller'],
  ]);
  assert.equal(errors.length, 0);
  assert.deepEqual(topoOrder(cues), ['E1', 'S1', 'L1', 'L2', 'S2']);
});

test('exportCsv round-trips through the parser with identical digest', () => {
  const { cues } = validateScene([
    HEADER.split(','),
    ['E1', 'stage', 'enter', '-', 'human'],
    ['S1', 'sound', 'chime', 'E1', 'caller'],
    ['L1', 'lights', 'warm', 'S1', 'caller'],
  ]);
  const csv = exportCsv(cues);
  const parsed = parseCsv(csv);
  const again = validateScene(parsed.rows);
  assert.equal(again.errors.length, 0);
  assert.equal(digestCues(again.cues), digestCues(cues));
  assert.deepEqual(again.cues.map((c) => c.id), cues.map((c) => c.id));
});

test('exportCsv neutralizes spreadsheet formulas', () => {
  const { cues } = validateScene([
    HEADER.split(','),
    ['E1', 'stage', '=SUM(1,2)', '-', 'human'],
  ]);
  const csv = exportCsv(cues);
  assert.match(csv, /'=SUM\(1,2\)/);
});
