# Sync2 Worker Reorganization

**Branch:** `sync2-worker-reorg` (cut from `main` @ `fead510`)
**Target release:** `2.0.1-beta6` (replaces shipping of separate hotfix beta6)
**Status:** planning
**Created:** 2026-05-30
**Co-design:** Vladyslav Kozlovskyy + Claude Code + /advisor

---

## 1. Context

Between 2.0.1-beta5 ship and now (May 26–30), a multi-day field
investigation on Obsidian Mobile (Pixel 6 Pro) chased a sync hang
that locked the UI when a multi-megabyte markdown reached the
reconcile path. The hang was reproducible in production and refused
to reproduce in any of seven synthetic diagnostic harnesses written
during the investigation:

- Heap pressure (10 MB strings + read) — passed
- `requestUrl` after-effect (2 × 900 KB GitHub fetches + read) — passed
- `base64ToArrayBuffer` on 2.6 MB ASCII payload — passed
- `base64ToArrayBuffer` × 15 back-to-back — passed
- `fetch(getResourcePath)` 1.9 MB — passed
- `diff3` mergeText escalation to 4.6 MB — passed (cliff at ~4 MB)
- Web Worker feasibility (Blob URL) — **passed: Workers DO work**

The fix that shipped on the user's phone (build `df6a1e09`) is a
size guard: skip 3-way merge for files > 1 MB, push ours bytes as-is.
This works but is a workaround — large-file divergence loses
automated 3-way merge on mobile.

**The Web Worker discovery (last test before this rework) changes
the constraint set:** with proven Worker support, CPU-heavy
operations can move off the JS main thread, the bridge stays
responsive, the size guard remains as defense in depth but no longer
defines the user-facing limit.

This document plans a clean reorganization on a fresh branch from
`main`, picks the empirically-validated learnings forward, and
removes the experimental scaffolding that didn't pan out.

---

## 2. Decisions taken

| # | Decision | Value | Rationale |
|---|---|---|---|
| D1 | Branch base | `main` @ `fead510` | Clean slate; diff2 keeps Phase 1-4 progress isolated |
| D2 | Production fix path | Reorg branch ships as `2.0.1-beta6` | User accepts wait; one coherent release beats two |
| D3 | Phase 5 (DiffEditor from DIFF-EDITOR.md) | **Postponed** to a later release | Focus this rework on engine; UI follow-on later |
| D4 | Settings → Mobile diagnostics buttons | **Delete all** | Move logic into proper unit/integration tests |
| D5 | Test strategy | **No regressions allowed, only improvements** | All current 635 unit tests must pass; new tests add coverage |

---

## 3. Empirically validated learnings (carry forward)

These passed real-device tests and matter for the rework:

1. **`fetch(getResourcePath)` for queue reads** — bypasses Capacitor
   base64 bridge; faster than `vault.adapter.readBinary`; works for
   both queue snapshots and live vault paths.
2. **Size guard** `RECONCILE_AUTO_MERGE_LIMIT = 1_000_000` — kept as
   defense in depth. node-diff3 hits a real cliff at ~4 MB
   regardless of where it runs.
3. **SHA-skip before push** — if ours.sha === theirs.sha skip the
   blob upload; saves real bandwidth on large-file no-op pushes.
4. **Read ours FIRST in reconcile** — clean WebView state for the
   `fetch` call; consistent ~25 ms read regardless of preceding
   blob fetches.
5. **`setTimeout(0)` yield between batch files** — fixes UI freeze
   from microtask-only awaits; bridge gets time to process queued
   appends.
6. **60 s per-file timeout in reconcile** — cheap insurance, surfaces
   any stuck path as a clean error.
7. **Blobs-API fallback in `getContentsAtRef`** (beta5 fix) —
   catastrophic-data-loss prevention. Must stay.
8. **`PushQueue.readFile` unit tests** (18 tests added in beta5) —
   round-trip integrity across text/binary, small/large, special
   chars in paths, empty files, deep nesting. Keep.
9. **Web Worker via inline Blob URL** — proven 46 ms round-trip for
   2.6 MB base64 decode. Production-ready.

---

## 4. Experimental scaffolding (delete)

These were investigation artifacts, falsified or superseded:

- All 9 buttons in Settings → Mobile diagnostics:
  - Run experiment (5-strategy probe)
  - Run base64 decode test (size matrix)
  - Run base64 N-iterations test
  - Run staged sync reproducer
  - Run heap-pressure stress test
  - Run requestUrl-after-effect test
  - Run diff3 size escalation
  - Run Web Worker feasibility test
  - Dump breadcrumbs / Clear breadcrumbs
- `src/breadcrumb.ts` and all `bc()` calls in `sync2-manager.ts` and
  `main.ts`
- `asyncBase64ToArrayBuffer` in `src/utils.ts` — falsified by N-iter
  test, complexity without benefit
- "Decode-early + free intermediate strings" pattern — based on
  falsified heap-pressure hypothesis
- Most granular probes (`about-to-decode-theirs`, etc.) — keep
  `Sync2 reconcile path enter` and a single per-file outcome log;
  the rest were diagnostic-only

---

## 5. New architecture (Web Worker offload)

### 5.1 Worker infrastructure

- **One shared Worker per plugin instance**, lazy-init on first use,
  kept alive for session.
- **Message protocol** with request IDs (concurrent ops multiplex
  freely; tree-builder might fire multiple SHA computations in
  parallel).
- **esbuild separate entry point** at `src/worker/sync-worker.ts`,
  bundled as IIFE, inlined into main bundle as a string for Blob
  URL construction. Avoids `importScripts(url)` (Capacitor `app://`
  URLs in worker context are unproven and risk regression).
- **Graceful fallback to main-thread execution** if `new Worker()`
  throws (older Capacitor versions, security policies). Size guard
  remains the safety net.

### 5.2 Operations to offload (priority order)

Worker has ~5–10 ms postMessage overhead, so only move what
benefits. Threshold-gate every migration.

1. **`mergeText` (node-diff3)** — biggest win. 3-second freeze →
   3 seconds in background, UI live.
2. **`calculateGitBlobSHA`** for files > 100 KB — moderate win,
   runs many times per sync.
3. **`base64ToArrayBuffer`** for strings > 2 MB — eliminates entire
   class of "mobile bridge hang" risk.
4. **Do NOT move small operations**. Threshold-gate; below the
   threshold, main-thread execution wins.

### 5.3 Bundle size impact

Current `main.js`: ~150 KB. Worker code adds ~50 KB (node-diff3
core + atob wrappers + SHA-1). Total ~200 KB. Acceptable; document
in CHANGELOG.

---

## 6. Open architectural decisions (resolve before each stage)

These need explicit answers as each stage starts:

| Topic | Choices | Pending |
|---|---|---|
| Worker lifecycle | per-plugin / per-sync / per-batch | per-plugin recommended |
| node-diff3 in worker | full library / extracted merge | full library (smaller delta) |
| SHA-first reconcile | in scope here / follow-up | in scope (pairs with Worker) |
| Worker threshold | 500 KB / 1 MB / 2 MB | 1 MB recommended (will test) |
| Cancellation API | yes / no | yes (second click on `[Sync]` opens confirm-cancel modal — no separate button) |
| Raise size guard limit | 1 MB → ? after Workers | empirically determine after perf tests |

---

## 7. Migration sequence

Each stage is **independently shippable** and ends with a clean
commit. Tests must pass between stages.

### Stage 1: Strip experimental scaffolding (~2 hours)

Goal: clean slate that matches `main` but with the validated beta5
fixes ready to land.

- Branch already starts from clean `main`.
- Verify `pnpm build` + `pnpm test` pass before adding anything.
- Commit: nothing in this stage; baseline is `main`.

### Stage 2: Land validated beta5 learnings (~3 hours)

Goal: bring the proven fixes from the experimental WIP into clean
commits.

Each as a separate commit:
1. `fetch(getResourcePath)` in PushQueue.readFile + 18 unit tests
2. Size guard `RECONCILE_AUTO_MERGE_LIMIT = 1_000_000`
3. SHA-skip before push (skip blob upload if ours === theirs)
4. Read ours FIRST in reconcile
5. `setTimeout(0)` yield between batch files
6. 60 s per-file timeout
7. Update sync2-manager.test.ts coverage for these paths

**Acceptance:** all 635 existing unit tests pass + new unit tests
pass + the integration F-large-file-over-1mb suite passes.

### Stage 3: Worker infrastructure POC (~3-4 hours)

Goal: prove the Worker bundle pipeline end-to-end.

- esbuild config: separate entry point for worker.ts
- Build pipeline: inline built worker code as string into main bundle
- `src/worker/worker-client.ts` — main-thread side; lifecycle, message
  protocol, request ID multiplexing
- `src/worker/sync-worker.ts` — worker side; pings + echo for now
- New unit tests: worker construction, ping/pong round-trip, request
  ID multiplexing
- New integration test: worker survives across multiple syncs

**Acceptance:** ping/pong + bundle inspection (no `require('fs')`
at module level), all tests pass.

### Stage 4: Migrate `mergeText` to Worker (~3-4 hours)

Goal: 3-way merge runs in background; size guard ceiling rises.

- Worker bundles node-diff3
- Async wrapper around postMessage with promise-per-request
- Main-thread fallback if Worker fails / unavailable
- Raise `RECONCILE_AUTO_MERGE_LIMIT` to 3 MB (verified empirically)
- New unit tests: large-file (3 MB synthetic markdown) merge via
  worker, worker failure → main-thread fallback
- New integration test: real GitHub round-trip with 3 MB file
  divergence on both sides

**Acceptance:** UI stays responsive (no main-thread lock-up) during
merge of 1-3 MB inputs on real Obsidian Mobile.

### Stage 5: SHA-first reconcile (~4-6 hours)

Goal: most reconcile paths skip byte fetch entirely.

- Store SHA in queue manifest at enqueue time (cost: one SHA per
  changed file at enqueue; recovered as N savings per reconcile)
- Reconcile compares SHAs before fetching content
- Branches:
  - `base.sha === theirs.sha` → no remote change, push ours
  - `base.sha === ours.sha` → theirs wins; fetch theirs, write to
    vault
  - `theirs.sha === ours.sha` → ours wins, push as-is
  - all three differ → fetch both, merge (via Worker per Stage 4)
- New unit tests: each branch of the SHA matrix
- New integration tests: SHA-only no-op, SHA-only theirs-wins on
  large files

**Acceptance:** 75% of "no real change" reconcile paths skip blob
fetch; observed in integration suite.

### Stage 6: Migrate large base64 decode to Worker (~2 hours)

Goal: eliminate the entire "mobile bridge hang" risk class.

- Threshold-gated: only for strings > 2 MB
- Worker uses native `atob` (proven OK in feasibility test)
- New unit tests: decode > 2 MB via worker matches main-thread
  output byte-exact

**Acceptance:** no main-thread freeze observable when reconcile of
3 MB markdown file runs on phone.

### Stage 7: Cancellation + UX polish (~3-4 hours)

Goal: user can abort a stuck sync; sees progress per file.

**Cancellation UX — second click on [Sync] = confirm-cancel modal.**
No separate `[Cancel sync]` button; the existing Sync ribbon icon /
command becomes context-aware:
- When idle → opens the regular sync flow
- When a sync is in flight → opens a small confirmation modal:
  "A sync is currently in progress. Would you like to cancel it?"
  with buttons `[Cancel sync]` (red) / `[Keep going]` (default).
- Modal also shows live progress: "Currently processing N of M
  files (path: …)" so the user knows whether to wait.
- The pre-sync conflict modal (PreSyncConflictModal) is unaffected
  — that's a separate guard before sync starts.

Implementation:
- Per-file progress state held on `Sync2Manager` (`current`, `total`,
  `currentPath`), surfaced via callback the UI subscribes to.
- The same callback also drives a per-file Notice
  ("Reconciling X/N: <path>") that replaces the static "Push 0/4
  files to GitHub" counter the user found unhelpful in the field
  incident.
- Cancellation flag on `Sync2Manager` (`abortRequested`); drain
  checks between files. If a Worker job is in flight, also calls
  `worker.terminate()` so CPU-heavy operations stop immediately.
- Stuck-batch detection: if drain attempt has been "running" for
  > 5 min, surface a passive Notice — but the second-click modal
  is the primary recovery path.
- New unit tests: cancellation during merge, cancellation propagates
  to Worker, second-click modal lifecycle.

**Acceptance:** in a deliberate-hang test, the second Sync click
opens the confirmation modal within 1 second; choosing
`[Cancel sync]` returns the UI to interactive state in another
~1 second.

### Stage 8: Perf tests + final size-guard tuning (~3 hours)

Goal: replace diagnostic buttons with proper perf coverage.

New files under `tests/perf/`:
- `diff3-timing-matrix.test.ts` — 100 KB to 5 MB; assert max times
  per-size; opt-in via `npm run test:perf`
- `base64-decode-timing.test.ts` — sync vs Worker, 100 KB to 10 MB
- `worker-roundtrip-overhead.test.ts` — measure postMessage cost
  for various payload sizes
- `sha-computation-timing.test.ts` — SHA computation overhead

Empirically tune:
- Final `RECONCILE_AUTO_MERGE_LIMIT` (probably 3 MB with Workers)
- Worker threshold for each operation
- Document mobile cliff behaviour

**Acceptance:** perf tests run green locally (not in CI by default);
documented baselines in `tests/perf/README.md`.

### Stage 9: Release prep (~2 hours)

- Bump versions: package.json, manifest.json, manifest-beta.json,
  versions.json (→ 2.0.1-beta6)
- Update `CHANGELOG.md` with rework summary
- Update `docs/PSEUDO-MERGE-MODE.md` § (new section for Worker
  architecture)
- Update `CLAUDE.md` with new architecture references
- Final test sweep: `pnpm build` + `pnpm test` + integration suite

---

## 8. Test strategy ("no regressions, only improvements")

### 8.1 What must NOT regress

- All 635 existing unit tests pass green
- All integration scenarios (A through L buckets) pass
- `F-large-file-over-1mb.test.ts` (1.5 MB markdown round-trip)
  passes — extend to 3-5 MB during Stage 4

### 8.2 New unit tests added per stage

- Stage 2: ~30 new unit tests (size guard + SHA-skip + yield +
  timeout)
- Stage 3: ~10 worker-infrastructure tests
- Stage 4: ~20 worker-merge tests (escalating size, fallback)
- Stage 5: ~25 SHA-first reconcile tests (matrix of branches)
- Stage 6: ~10 worker-base64 tests
- Stage 7: ~15 cancellation + progress tests

**Total new unit tests:** ~110, bringing the suite to ~745.

### 8.3 New integration tests

- `F-large-file-3mb.test.ts` — 3 MB markdown 3-way merge via worker
- `F-large-binary-5mb.test.ts` — 5 MB binary push + pull
- `J-worker-fallback.test.ts` — Worker construction fails →
  graceful main-thread fallback
- `J-cancellation.test.ts` — user cancels mid-sync, state stays
  consistent
- `H-sha-first-no-op.test.ts` — same content both sides → zero
  network upload

### 8.4 Perf tests (Stage 8)

Opt-in `tests/perf/` covering text + binary up to 10 MB. Document
expected ranges; flag the mobile cliff at ~4 MB.

---

## 9. Risk + mitigation

| Risk | Likelihood | Mitigation |
|---|---|---|
| Worker bundle pipeline breaks build | medium | Stage 3 isolated; revert is one commit |
| Worker doesn't actually help main-thread responsiveness | low (feasibility test passed) | Keep size guard as fallback |
| node-diff3 has subtle behaviour difference in worker scope | low (pure JS lib) | Byte-exact merge comparison test main-thread vs worker |
| Capacitor older versions reject Workers | low (modern Obsidian Mobile tested OK) | Graceful fallback to main thread |
| Mobile cliff at ~4 MB still bites even in Worker | high | Size guard at 3 MB; large files create conflict siblings (Phase 5 / diff2 territory) |
| User force-stops phone mid-rework | n/a | Existing fixes on user's phone stay until beta6 ships |
| Phase 5 (DiffEditor) integration breaks | n/a | Phase 5 postponed; diff2 branch untouched |

---

## 10. Consolidation of existing tasks

These tasks fold into this rework:

| Task | Disposition |
|---|---|
| #5 zero-byte → conflict | Subsumed by Stage 5 (SHA-first) |
| #6 size-collapse heuristic | Optional Stage 7 polish |
| #7 decision logging in reconcile | Subsumed by clean logger in Stage 2 |
| #12 reconcile UI responsiveness | Stage 7 |
| #13 reconcile memory ceiling | Stage 4 + Stage 6 |
| #14 sync cancellation | Stage 7 |
| #15 3-way merge in worker | Stage 4 — the centerpiece |
| #16 stream-fetch large blobs | Postponed (Worker already addresses) |
| #17 queue.readFile timeout workaround | Closed by Stage 2 land |
| #18 dedup pending-batch SHA check | Stage 5 |
| #19 systemic readBinary removal | Stage 2 lands the fetch path |
| #20 diff3 size-threshold → diff-editor | Out of scope; postponed |

Tasks #8 (pre-push confirmation modal), #9 (forensic investigation
of desktop zeroed files), #10 (corruption-resilience scenarios) stay
as separate backlog items.

---

## 11. Out of scope

- Phase 5 DiffEditor UI (DIFF-EDITOR.md) — postponed
- Diff2 branch work — continues independently
- Web Worker for ChangeDetector vault scan — future
- Mobile binary file > 1 MB push optimization beyond what Worker
  buys — future

---

## 12. Execution rules

1. Each stage is one or a few clean commits with passing tests.
2. **Do not merge stages out of order.** They're sequenced for a
   reason: Stage 4 depends on Stage 3, Stage 5 changes assumptions
   for Stage 4 measurements, etc.
3. Between stages: `pnpm build` + `pnpm test` must be green. If
   not, halt and fix.
4. Commit messages follow Conventional Commits + the
   `Co-Authored-By: Claude` trailer per `CLAUDE.md` policy.
5. Push to remote after each completed stage so the branch is
   resumable from any device.
6. **No diagnostic buttons leak into production.** All
   investigation logic lives in `tests/perf/` or unit tests, never
   in Settings tab.

---

## 13. Open follow-ups (future releases)

- Web Worker for ChangeDetector
- Native scroll vs JS event loop deep-dive (for future
  responsiveness work)
- Stream-fetch large blobs (instead of full materialization)
- Pre-push confirmation modal for dramatic size drops (#8)
- Forensic investigation of the original desktop zeroed-files
  incident (#9)
- Corruption-resilience integration scenarios (#10)
