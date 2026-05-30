# Sync2 Worker Reorganization

**Branch:** `sync2-worker-reorg` (cut from `main` @ `fead510`)
**Target release:** `2.0.1-beta6` (replaces shipping of separate hotfix beta6)
**Status:** planning
**Created:** 2026-05-30
**Co-design:** Vladyslav Kozlovskyy + Claude Code + /advisor

---

## 0. Guiding principles

These are the architectural North Stars that every stage in this
rework must serve. If a design choice within a stage conflicts
with one of these, the principle wins and the choice is revised.

### P1. "Click Sync, keep editing"

The plugin must never freeze the user's editor while it does
GitHub work. The existing `.push-queue` already gave offline
resilience and crash safety — the missing piece is that the active
drain still blocks the JS main thread when it crunches CPU. With
Web Workers proven (see §1) we can route every CPU- or
network-heavy operation off the main thread, so the user keeps
typing while the plugin syncs in the background.

This implies: anything that takes more than a frame (~16 ms) of
main-thread time is a candidate for the Worker orchestra.

### P2. SHA-first by default — never read or push what we already know

Every reconcile, push, and pull decision should start from
SHAs alone:

- `ChangeDetector` skips a file when `mtime + size` match its
  manifest snapshot — never re-reads bytes when the metadata
  proves the file unchanged.
- `enqueue` stores the file's SHA alongside path + mtime + size
  in the manifest, computed once at change-detection time.
- Reconcile compares `ours.sha` vs `base.sha` vs `theirs.sha`
  before fetching any bytes. ~75 % of paths resolve from SHAs
  alone (no remote change / ours wins / theirs wins).
- Push pipeline checks GitHub-side blob SHA before uploading
  bytes (if the blob exists with the right SHA, just reference it
  in the tree — never re-upload).

This pays for itself on every sync, not only large-file ones.
A 200-file vault with three changed files runs three SHA reads
instead of three byte reads — orders of magnitude less I/O and
network.

### P3. Worker orchestra, not a single Worker

The Web Worker feasibility test (§1) proved one Worker round-trip
costs ~5–10 ms. Constructing a Worker per operation is wasteful;
sharing one Worker across all operations serializes work that
could parallelize. The right answer is a small orchestra:

- **CPU worker pool** (2–4 workers): parallel base64 decode for
  different files, parallel diff3 merges, parallel SHA
  computation. Pool size auto-tunes to `navigator.hardwareConcurrency`
  with a sane fallback of 2.
- **Dedicated network worker** (1): all GitHub API calls in
  serial. Rate-limiting, retry backoff, and quota accounting
  stay in one place. Pre-flight validation (§12.1 of
  PSEUDO-MERGE-MODE.md) lives here.
- **Main thread**: orchestration only — triggers, UI state, fast
  vault reads (~25 ms each), postMessage to/from workers, settings.

Timeouts in workers can be generous (5–10 min for a giant merge)
because the user is never blocked — they just see live progress
and have the `[Cancel sync]` modal (Stage 7) if they want to stop.

### P4. No regressions allowed

All 635 existing unit tests stay green. Every stage of this
rework either adds tests or refines existing ones — never deletes
coverage. Integration scenarios (A through L buckets) stay
intact.

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
   both queue snapshots and live vault paths. **`getResourcePath` is
   an officially documented part of Obsidian's `DataAdapter` API** —
   not a hack. On mobile the URL takes the form
   `http://localhost/_capacitor_file_/...`, a Capacitor-internal
   scheme designed so WebView's native fetch can resolve local
   files without a JS↔native bridge round-trip. Use confidently,
   document the design choice in CLAUDE.md.

2. **Size guard** `RECONCILE_AUTO_MERGE_LIMIT` — kept as defense in
   depth. node-diff3 hits a real cliff at ~4 MB regardless of where
   it runs. Default value is **provisional** — set to 5 MB based on
   the Stage 4 perf data, and **exposed in Settings** as
   `maxAutoMergeSizeBytes` so advanced users can tune up or down
   for their corpus. Stage 8 perf tests provide the empirical
   baseline.

3. **SHA-first as universal strategy** — this is the centerpiece, see
   §0 P2. Not a "skip when sha matches" special case; the manifest
   stores `{ path → sha, mtime, size, lastSynced }` and every
   decision starts from SHAs alone. ChangeDetector skips a file when
   `mtime + size` match the snapshot — no byte read needed at all.
   Reconcile compares SHAs before fetching content. Push checks
   GitHub blob existence before uploading. Stage 5 implements this.

4. **Read ours FIRST in reconcile** — still applies as a clean
   ordering choice, but the original *reason* (clean WebView state
   for the read) disappears once the Worker orchestra absorbs CPU
   work. With workers, main thread isn't competing with
   heavy operations during the read. The pattern stays for code
   clarity (read what we know is local first, then go to network)
   but framing in code comments must update.

5. **`setTimeout(0)` yield between batch files** — fixes UI freeze
   from microtask-only awaits on the main thread. Once the entire
   reconcile loop moves into a Worker, this matters less inside
   the loop, but the main thread still needs yields between
   high-level orchestration steps (batches drained, UI updates).
   Keep the pattern; document it as a main-thread tool, not a
   blanket prescription.

6. **60 s per-file timeout in reconcile** — keep as a safety net,
   but **raise considerably in Workers**. With main thread free,
   the user doesn't experience the timeout-firing as a freeze; we
   can let a giant merge run 5–10 min in the CPU pool. The
   user-facing escape is the `[Cancel sync]` modal (Stage 7), not
   an automatic timeout. Main-thread step timeouts stay tight.

7. **Blobs-API fallback in `getContentsAtRef`** (beta5 fix) —
   catastrophic-data-loss prevention. Must stay. **In the new
   architecture, the fallback logic lives inside the dedicated
   network worker** (see §5), since that worker owns all GitHub
   API calls and contains the retry/error-classification policy.

8. **`PushQueue.readFile` unit tests** (18 tests added in beta5) —
   round-trip integrity across text/binary, small/large, special
   chars in paths, empty files, deep nesting. Keep.

9. **Web Worker via inline Blob URL** — proven 46 ms round-trip for
   2.6 MB base64 decode. Production-ready. **Builds the foundation
   for the Worker orchestra** (§0 P3, §5).

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

## 5. New architecture — Worker orchestra

The plugin runs as a small orchestra of cooperating threads. The
main thread orchestrates and handles UI; CPU work parallelizes
across a pool; network I/O serializes through a dedicated worker.
This is the implementation of §0 P3.

### 5.1 Thread layout

```
                  ┌─────────────────────────────────────┐
                  │           Main thread               │
                  │  • UI, settings, triggers           │
                  │  • Fast vault reads (~25ms each)    │
                  │  • Orchestration: who does what     │
                  │  • postMessage in/out               │
                  └────────┬────────────────┬───────────┘
                           │                │
            ┌──────────────┴───┐    ┌───────┴────────────┐
            │  CPU worker pool │    │  Network worker    │
            │  (2-4 workers)   │    │  (single)          │
            │                  │    │                    │
            │ • base64 decode  │    │ • GitHub API calls │
            │ • diff3 merge    │    │ • Blobs fallback   │
            │ • SHA-1 compute  │    │ • Retry / backoff  │
            │ • parallel       │    │ • Rate-limit       │
            │   per-file       │    │ • Pre-flight       │
            └──────────────────┘    └────────────────────┘
```

**Pool size auto-tunes** to `Math.max(2, Math.min(4, navigator.hardwareConcurrency - 1))`
with a fallback of 2 if the API is unavailable.

### 5.2 Build infrastructure (Approach A confirmed)

- **esbuild separate entry points:**
  - `src/worker/cpu-worker.ts` — pool worker, includes node-diff3
    library, atob wrapper, SHA-1 implementation.
  - `src/worker/network-worker.ts` — GitHub API client, retries,
    Blobs fallback.
- Each builds as a standalone IIFE → string → inlined into the
  main bundle as `const CPU_WORKER_SOURCE = "..."` and
  `const NETWORK_WORKER_SOURCE = "..."`.
- Runtime: `new Worker(URL.createObjectURL(new Blob([CPU_WORKER_SOURCE], { type: "application/javascript" })))`.
- This avoids `importScripts(url)` (Capacitor `app://` URLs in
  worker context are unproven and risk regression).

### 5.3 Message protocol

Single typed envelope with request IDs so any worker can multiplex:

```typescript
type WorkerRequest =
  | { id: string; op: "decode-base64"; b64: string }
  | { id: string; op: "merge-text"; ours: string; base: string; theirs: string }
  | { id: string; op: "compute-sha"; bytes: ArrayBuffer }
  | { id: string; op: "github-blob-get"; sha: string }
  | { id: string; op: "github-blob-create"; bytes: ArrayBuffer }
  | { id: string; op: "github-tree-create"; entries: TreeEntry[] }
  // (one variant per worker op — see WorkerClient for full set)
  ;
type WorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };
```

`WorkerClient` (main-thread wrapper) holds the pool, dispatches
based on op type (CPU-bound → next-free pool worker; network →
queued network worker), and returns a `Promise<result>` keyed by
request ID. Transferable `ArrayBuffer`s move zero-copy.

### 5.4 Operations to offload (priority order)

Worker round-trip ~5–10 ms. Only offload above-threshold:

1. **`mergeText` (node-diff3)** → CPU worker, any size ≥ 100 KB.
   The biggest win: 3 s freeze becomes 3 s in background, UI live.
2. **`calculateGitBlobSHA`** → CPU worker, files ≥ 100 KB. Many
   per sync; cheap parallelism win.
3. **`base64ToArrayBuffer`** → CPU worker, strings ≥ 2 MB.
   Eliminates the mobile bridge hang risk entirely.
4. **All GitHub HTTP calls** → network worker. Single point of
   retry, rate-limit, error classification (per `errors.ts`).
   Blobs-API fallback (§3 item 7) lives here.
5. **Reconcile orchestration** stays on main thread — it just
   coordinates many short workers, never doing heavy work
   itself. ChangeDetector + push-queue persistence + manifest
   updates stay on main thread (touch vault.adapter, which only
   works from main).

### 5.5 Graceful fallback

If `new Worker()` throws (security policy, older Capacitor, etc.),
the `WorkerClient` falls back to main-thread execution of every
operation. Size guard (§3 item 2) remains the secondary safety net
for the CPU operations. Detected once at construction; cached;
covered by tests.

### 5.6 Cancellation

`worker.terminate()` is synchronous and instant. The `WorkerClient`
maintains an "abort signal" tied to the per-sync session; if the
user clicks the `[Cancel sync]` modal (Stage 7), it:

1. Sets the `abortRequested` flag on `Sync2Manager`.
2. Terminates every in-flight Worker job (CPU pool + network
   worker).
3. Re-creates fresh workers from the pool source string for the
   next sync. (Cheap — Blob URL + new Worker is ~5–10 ms.)
4. Drain returns gracefully, batch stays in `.attempted` state on
   disk so the next sync retries cleanly.

### 5.7 What workers CAN and CANNOT do (boundary)

This boundary informs every operation-placement decision in Stages
3-6 and prevents over-engineering toward a "do everything in
workers" design that physics won't allow.

**Workers CAN:**
- Call `fetch(url)` — including local files via URLs the main
  thread provides through `getResourcePath(...)`.
- Use Web Crypto API for SHA-1 (`crypto.subtle.digest`).
- Use `atob` for base64 decode.
- Bundle and run arbitrary pure-JS libraries (node-diff3, etc.).
- Receive transferable `ArrayBuffer`s zero-copy via postMessage.

**Workers CANNOT:**
- Call any Obsidian API (`vault.adapter.write`, `vault.read`,
  `app.workspace`, settings, etc.). These are main-thread only.
- Mutate the vault. **Every vault write — text, binary, rename,
  delete — must round-trip back to main thread via postMessage.**
- Construct other workers (nested workers are unsupported on
  Capacitor; even where supported, adds complexity for no
  measurable gain).

**Implication for read-from-disk:** for files already in
`.push-queue`, pass the worker a URL (`getResourcePath(target)`,
resolved on main thread) instead of bytes. The worker fetches
and processes — bytes never visit the main thread heap. Pattern:

```typescript
// Main:
const url = adapter.getResourcePath(`${queueRoot}/${id}/vault/${path}`);
const { sha } = await workerClient.computeSha({ url });
// `sha` is a tiny string — postMessage cost negligible.

// Inside CPU worker:
case "compute-sha": {
  const buf = await fetch(msg.url).then((r) => r.arrayBuffer());
  const sha = await crypto.subtle.digest("SHA-1", buf);
  return { sha: hex(sha) };
}
```

This pairs naturally with §0 P2 (SHA-first): the worker computes
SHAs without ever materializing bytes on the main thread.

**Implication for "main drain worker":** rejected. Drain
orchestration would have to round-trip every vault write back to
main anyway, eliminating the parallelism win; the main thread is
already a thin shim in the orchestra design. Keep main thread as
the orchestrator; let workers do CPU + network. Documented as
out-of-scope in §11.

**Implication for inter-worker filesystem channels:** rejected.
Transferable ArrayBuffers are zero-copy across postMessage —
they're not a memory cost. `.push-queue` already serves as the
durable filesystem channel; layering additional worker-to-worker
file coordination adds concurrency control, cleanup logic, and
error recovery for no measurable gain.

### 5.8 Bundle size impact

Current `main.js`: ~150 KB. Worker sources add:
- CPU worker (with node-diff3): ~60 KB
- Network worker (HTTP client + retries): ~30 KB

Total `main.js`: ~240 KB. Acceptable; document in CHANGELOG.

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
1. `fetch(getResourcePath)` in PushQueue.readFile + 18 unit tests ✅
2. Size guard `RECONCILE_AUTO_MERGE_LIMIT = 1_000_000` ✅
3. SHA-skip before push (skip blob upload if ours === theirs) ✅
4. Read ours FIRST in reconcile ✅
5. `setTimeout(0)` yield between batch files ✅
6. ~~60 s per-file timeout~~ → **deferred to Stage 7**. A real
   timeout that interrupts mid-iteration requires refactoring the
   reconcile body into an inner async function (so `continue`
   becomes `return`) plus an AbortController to actually cancel
   in-flight work. Stage 7's cancellation infrastructure provides
   exactly this — adding both means writing the same plumbing
   twice. With the size guard (#2) preventing the only known
   real-world hang scenario, the timeout is defense against a
   class of bugs we haven't found, not a known crash. Defer.
7. ~~Update sync2-manager.test.ts coverage for these paths~~ →
   the 635 existing unit tests guarantee no regression; the
   `F-large-file-over-1mb` integration test exercises the
   size-guard + SHA-skip path naturally. Stage 8 perf tests will
   add dedicated timing matrices that cover these as a side
   effect.

**Acceptance:** all 635 existing unit tests pass; build green;
new behaviour is documented in code comments referencing the
plan principles.

### Stage 3: Worker orchestra infrastructure POC (~4-5 hours)

Goal: prove the full orchestra build pipeline + pool + dedicated
network worker shape, end-to-end.

- esbuild config: two separate entry points
  - `src/worker/cpu-worker.ts`
  - `src/worker/network-worker.ts`
- Build pipeline emits each as a standalone IIFE → string →
  inlined into the main bundle as `const CPU_WORKER_SOURCE` and
  `const NETWORK_WORKER_SOURCE`.
- `src/worker/worker-client.ts` — main-thread orchestra controller:
  - Constructs CPU pool (auto-sized to
    `Math.max(2, Math.min(4, hardwareConcurrency - 1))`).
  - Constructs the single network worker.
  - Maintains pending-request map keyed by request ID.
  - `dispatch(op)` — picks the right worker (CPU vs network) and
    returns `Promise<result>`.
  - `terminateAll()` for cancellation.
  - Graceful fallback: if `new Worker()` throws, every op runs
    on main thread instead.
- Stage 3 ops shipped:
  - CPU worker: `ping` + `echo` only (no node-diff3 yet).
  - Network worker: `ping` only.
- New unit tests:
  - Worker pool construction + size matches expected
  - Round-trip ping/pong against CPU pool and network worker
  - Request ID multiplexing (10 concurrent pings, all return)
  - Graceful fallback when Worker constructor throws (mock)
- New integration test: orchestra survives across two consecutive
  Sync2Manager.syncAll() calls (no leak, no construction-per-sync).
- Bundle inspection: `main.js` contains the worker sources as
  string literals; **no `require('fs'|'path')` at module scope**
  per CLAUDE.md mobile constraint.

**Acceptance:** orchestra pings green, pool size correct on a
test machine, fallback works, all tests pass.

### Stage 4: CPU worker — mergeText + SHA + base64 (~4-5 hours)

Goal: parallel CPU work across the pool; UI stays responsive
during multi-second compute.

- Add `merge-text`, `compute-sha`, `decode-base64` ops to
  `cpu-worker.ts`.
- Worker bundles node-diff3 (~50 KB), a SHA-1 implementation
  (built-in `crypto.subtle.digest('SHA-1', ...)` works in worker
  scope), and uses native `atob` for base64.
- `WorkerClient.mergeText`, `computeSHA`, `decodeBase64` — async
  wrappers; dispatch picks an idle pool worker.
- Reconcile / push-queue / tree-builder updated to call these via
  `WorkerClient` instead of direct synchronous library calls.
  Threshold-gated per §5.4.
- Raise `RECONCILE_AUTO_MERGE_LIMIT` per Stage 8 perf data;
  provisional 5 MB.
- New unit tests:
  - 3 MB merge via worker pool, byte-exact vs main-thread result
  - 4 concurrent merges run in parallel (timing assertion)
  - Worker failure → main-thread fallback path
  - Decode > 2 MB byte-exact vs `base64ToArrayBuffer`
- New integration tests:
  - Real GitHub round-trip with 3 MB file divergence on both sides
  - Two large files in same batch — merges run in parallel

**Acceptance:** UI stays responsive (verified on a Pixel 6 Pro
running Obsidian Mobile) during merge of 1-3 MB inputs.

### Stage 5: SHA-first as default (manifest mtime+size cache + reconcile rework) (~5-7 hours)

Goal: implement §0 P2 fully. Universal SHA-first strategy with
manifest cache so we never read or push what we already know.

**Manifest cache (foundation):**
- Extend `SnapshotStore`'s per-path record to
  `{ sha, mtime, size, lastSynced }` (currently just `sha`).
- `ChangeDetector` first checks `mtime + size` against snapshot;
  if both match, the file is provably unchanged — skip the read
  entirely. This is the biggest day-to-day win: a 200-file vault
  with 3 changed files does 3 reads instead of 200.
- If `mtime` or `size` differ, read the file once, compute SHA via
  the CPU worker pool (Stage 4), compare to snapshot.sha. If
  matching, it's a false-alarm (touch without content change) —
  update mtime in snapshot, do nothing else.

**SHA-first reconcile:**
- Reconcile fetches base & theirs **metadata only** (Contents API
  returns SHA without content for files ≤ 1 MB; for larger it
  returns the metadata envelope and we skip the inline content).
- Branches before any blob fetch:
  - `base.sha === theirs.sha` → no remote change, push ours
  - `theirs.sha === ours.sha` → already in sync, drop from batch
  - `base.sha === ours.sha` → theirs wins; only theirs full bytes
    needed
  - all three differ → both full bytes needed, merge via Worker

**SHA-first push:**
- Before uploading a blob: check `GET /repos/.../git/blobs/{sha}`
  via the network worker. If GitHub already has this SHA, the
  tree-builder references it without re-uploading bytes — saves
  bandwidth, especially on large-file no-op pushes.

- New unit tests:
  - `ChangeDetector` skips read when `mtime + size` match
  - `ChangeDetector` rereads when `mtime` differs but content
    matches — updates snapshot mtime
  - Reconcile takes each SHA-matrix branch correctly
  - Push skips upload when GitHub-side blob already exists
- New integration tests:
  - 200-file vault, 3 changes — assert 3 reads (not 200)
  - SHA-only theirs-wins on a 3 MB file (no main-thread merge)
  - Push of a file whose blob already exists remotely (zero blob
    upload)

**Acceptance:** observed network/disk savings in integration
suite; SHA-skip path covered for all eight cells of the
ours/base/theirs SHA matrix.

### Stage 6: Network worker — GitHub API migration (~5-7 hours)

Goal: every GitHub HTTP call goes through the dedicated network
worker. Single point of retry, rate-limit, error classification,
and Blobs-API fallback (§3 item 7).

- Move `src/github/client.ts` HTTP-call methods into
  `src/worker/network-worker.ts`:
  - `getBranchHead`, `getContentsAtRef` (incl. Blobs fallback),
    `getBlob`, `getCompare`, `getTree`
  - `createBlob`, `createTree`, `createCommit`, `updateBranchHead`
  - Retry policy, rate-limit handling, error classification
    (typed errors from `src/errors.ts` are re-thrown on the main
    side via `WorkerResponse.ok: false`).
- `WorkerClient` exposes thin wrappers — `wc.getBranchHead(...)`,
  etc. — that look identical to today's `GithubClient` API. The
  call sites in `sync2-manager.ts`, `tree-builder.ts` swap to
  `WorkerClient` without otherwise changing.
- Main thread keeps a tiny `GithubClient` shim that delegates to
  `WorkerClient` so existing tests that mock `GithubClient`
  continue to work.
- Pre-flight validation (§12.1 of PSEUDO-MERGE-MODE.md) stays in
  Sync2Manager — it's orchestration, not network I/O.
- New unit tests:
  - Each HTTP op round-trips through worker correctly
  - Retry policy fires on 429 / 5xx
  - Typed errors deserialize correctly across the postMessage
    boundary
  - Network worker survives consecutive calls (no leaks)
- Integration tests: existing J-series (API failures) suite runs
  green against the network-worker-mediated client.

**Acceptance:** all integration tests pass; no `requestUrl` calls
on the main thread; the Blobs-API fallback lives entirely inside
the network worker.

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
- **"Main drain worker" that orchestrates everything from a
  worker thread.** Vault writes (`adapter.write/writeBinary/
  remove/rename`) are main-thread-only Obsidian APIs; any drain
  worker would have to round-trip every write back to main,
  eliminating the parallelism win. Main thread stays as the
  orchestrator (thin shim that dispatches to workers and performs
  writes). See §5.7 for the boundary analysis.
- **Filesystem-based inter-worker communication.** Transferable
  ArrayBuffers via postMessage are zero-copy, and `.push-queue`
  already serves as the durable filesystem channel. Layering
  worker-to-worker file coordination adds concurrency control
  and cleanup logic for no measurable gain. See §5.7.

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
