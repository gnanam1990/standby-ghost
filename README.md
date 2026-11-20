# standby-ghost

Multi-desk theatre rehearsal, cue recovery and ghost replay.

A substitute stage caller rehearses a missed entrance with the sound and
lighting desks, the system identifies the first wrong cue, and the crew gets a
corrected calling sheet. The app records **human rehearsal signals only** — it
never drives real stage equipment.

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite` store and `node:test`; no
  external services needed)

## Run

```sh
npm ci
npm run build
npm start          # http://localhost:8080
```

The durable store defaults to `./data/standby-ghost.db`. Override with
`SG_DB=/path/to/file.db` (or `SG_DB=:memory:`), port with `PORT`.

## Test

```sh
npm test           # typecheck build + node:test suite (14 pack tests wired to T-xxx names)
npm run typecheck
```

## Architecture

```
src/
  domain/    script model, CSV parser/validator, cue engine, replay reducer (pure TS)
  db/        embedded SQLite store, ordered migrations, transactional writes
  http/      tiny router, REST API, static client, WebSocket stream
public/      buildless ES-module client (caller desk, sound/lights desks, ghost review)
fixtures/    original authorized scene "The returning letter" (40s, 5 cues)
test/        node:test suites named after the pack's T-001…T-014 cases
.kiro/       spec, steering and hook materials used during development
docs/        architecture and decision records
```

Key properties:

- **Immutable script revisions** — every take pins a revision; exports round-trip
  with identical cue identities and digest.
- **Serialized cue engine** — commands carry `commandId`, `epoch` and
  `expectedSeq`; writes are transactional, so every accepted command produces at
  most one event and stale epochs/generations are rejected.
- **Ghost replay** — the first evidenced divergence between planned dependency
  order and observed human testimony is recomputed from the durable event log.

## License

MIT — see [LICENSE](LICENSE).
