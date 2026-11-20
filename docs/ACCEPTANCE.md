# Standby Ghost — acceptance report

Verified on a clean checkout of `gnanam1990/standby-ghost` @ merge `1a569a6`
(Node v22.23.1, macOS arm64): **28 node:test cases + 4 Playwright specs, all
pass**. This report and a fifth browser spec (`handoff.spec.mjs`, the owner
handoff flow) ship in the PR carrying this document — re-verify at that head.

Reproduce exactly:

```sh
git clone https://github.com/gnanam1990/standby-ghost.git
cd standby-ghost
npm ci
npx playwright install chromium   # once, on a clean machine (no sudo needed on Linux: add --with-deps)
npm test              # 28 node:test cases — all pass
npm run test:browser  # Playwright specs in real Chromium — all pass
npm start             # serves http://localhost:8080
npm run seed:demo     # public demo production + room + three join links
```

## The 14 pack cases

| Case | Result | Evidence |
|---|---|---|
| T-001 import → export → re-import preserves cue identity/digest | PASS | `test/t001-import-export.test.mjs` |
| T-001b imported revision survives server restart | PASS | same file |
| T-002 invalid import rejected with row details; prior draft retained | PASS | `test/t002-invalid-import.test.mjs` |
| T-003 three distinct role invitations join; roster shows them | PASS | `test/t003-room-join.test.mjs` |
| T-003b replace desk operator; prior generation revoked | PASS | `test/t003-room-join.test.mjs` |
| T-004 revoked/used/expired links rejected | PASS | `test/t004-identity-failures.test.mjs` |
| T-004b desk cannot issue caller commands; sequence preserved | PASS | `test/t004-identity-failures.test.mjs` |
| T-005 hold → skip E1 → resume at S1, persisted sequence | PASS | `test/t005-hold-skip-resume.test.mjs` |
| T-006 hold beats GO; delayed ACK/stale epoch rejected; dup permutations | PASS | `test/t006-stale-race.test.mjs` |
| T-007 disconnect after accepted ACK; retry returns one event | PASS | `test/t007-reconnect.test.mjs`, `test/browser/desk-offline.spec.mjs` |
| T-008 offline-queued action requires reconfirm after epoch change | PASS | `test/t008-stale-offline.test.mjs`, `test/browser/desk-offline.spec.mjs` (3 real role browsers) |
| T-009 first evidenced divergence at violated edge; parallel swaps legal | PASS | `test/t009-replay-divergence.test.mjs`, `test/browser/review.spec.mjs` |
| T-010 missing human timing → unknown, sequence/reasoning preserved | PASS | `test/t010-replay-missing-timing.test.mjs` |
| T-011 two takes across three role clients; corrected sheet exports; take 1 unchanged | PASS | `test/t011-revision-handoff.test.mjs`, `test/browser/handoff.spec.mjs` (real owner handoff UI) |
| T-012 revision + export retried after timeout → one revision, rows match approval | PASS | `test/t012-revision-idempotent.test.mjs` |
| T-013 stale generation socket inert; roster announces the swap | PASS | `test/t013-stale-socket.test.mjs` |
| T-014 hold/resume keyboard-completable at 375px + 200% zoom; reduced-motion overlay/table name the same divergence | PASS | `test/browser/a11y.spec.mjs` |

Additionally: `test/t-privacy-scoped-reads.test.mjs` covers the release
privacy fix (production directory, detail, script body, CSV export, room,
take, events and replay reads are scoped to owner or live room role; only
`is_demo` productions are public) and `test/browser/production.spec.mjs`
covers the single-binding and open-for-import UI regressions.

## PR / merge ledger

| PR | Scope | Impl SHA | Merge SHA |
|----|-------|----------|-----------|
| #1 | scaffold + M01 script/rights + CI | `2162913` | `514f1df` |
| #2 | M02 room/identity | `aa46a0e` | `7e7a49c` |
| #3 | M03 cue engine | `6ebfc43` | `a869e7c` |
| #4 | M04 live desks | `154bf78` | `11e6979` |
| #5 | privacy scoped reads + binding fixes + browser suite | `25b1ce0`, `61eac2e` | `f7e56ca` |
| #6 | M05 ghost replay + review UI | `90571d4` | `d221bba` |
| #7 | M06 revision handoff | `da838dc` | `1a569a6` |

Every CI run included `npm test` plus (from #5) `npm run test:browser` in
GitHub Actions on `ubuntu-latest`.

## Verified boundaries

- **Storage**: embedded `node:sqlite` — zero external services; durable file
  or `SG_DB=:memory:`. Postgres is not required.
- **Privacy**: private production material is unreadable without owner or
  live-role credentials; revoked sessions fail reads and writes; WS upgrade
  is refused and live sockets are re-checked per message.
- **Safety**: the app records human rehearsal signals only — no path to real
  stage equipment exists in the codebase.
- **Demo**: `npm run seed:demo` → one public production, one room, three
  join URLs. Printed URLs default to port 8080 (`--base=` to override).

## Explicitly unverified / not claimed

- **No Kiro assistance**: `kiro whoami` reports "Not logged in"; no `.kiro/`
  materials are shipped. Kiroween Kiro-evidence requirements are therefore
  not met and not claimed.
- **No external deployment**: there is no public/production URL. All
  evidence is local and CI-based.
- **No theatre/pilot feedback**: no human rehearsal pilot was run; "three
  role clients" evidence is automated Chromium contexts, not actors.
- **No event submission**: nothing was submitted to any contest.
- **Scale**: tested at rehearsal scale only; no load/performance evidence.
