# Sync2 — TODO

Leftover work from the 2.0.2-beta rework (Stages 1-9 of
`SYNC2-WORKER-REORG.md`, now removed). Items are grouped by
priority. Each entry has enough context to start without re-reading
the whole rework plan.

---

## P0 — Safety guards

### Zero-byte file → restore, not push  ✅ DONE (2.0.2-beta2)

Implemented as the zero-byte restore guard (SYNC2 §2.9). The
design landed as **restore-from-last-good-version**, not the
"register conflict" framing the original draft proposed — a
0-length file is semantically indistinguishable from an
accidental deletion, so the engine treats it as an un-delete:
restore the last good content and drop the empty copy from the
push so the 0-byte version never reaches GitHub. No ConflictStore
machinery — nothing was pushed yet, so no commit is dropped.

Restore source, "last available version before it became 0":
  1. All pending push-queue batches, newest-first (the freshest
     non-zero frozen copy wins — covers zeroed-then-retyped).
  2. GitHub via the snapshot's remoteSha (last-synced content).

Carve-outs (the empty file goes through unchanged):
  - no snapshot entry  → brand-new file the user just created
  - snapshot.size === 0 → file was already empty last sync

Intentional empty file: the user deletes the file + commits
(which removes the snapshot row), THEN creates a 0-byte file.
With no snapshot row, the guard's "no snapshot" carve-out lets
it through — the empty file pushes and old data does NOT return.

Never silent: `onZeroByteRestored` fires a Notice + log line.

Shipped: `Sync2Manager.applyZeroByteRestoreGuard` +
`findLastGoodVersion`; `PushQueue.fileSize`; main.ts Notice.
Unit matrix in `tests/sync2/sync2-manager.test.ts` (6 cases).

### Corruption-resilience scenarios  ✅ DONE (2.0.2-beta2)

Integration tests in
`tests/integration/scenarios/sync2/corruption/zero-byte-restore.test.ts`
(verified against real GitHub):
- Zero-byte local + non-empty remote → restored from GitHub, no
  0-byte push; remote unchanged. ✅
- Brand-new 0-byte file (no snapshot history) → pushed as a
  legitimate empty file. ✅
- **Intentional empty via delete+recreate**: delete file + commit
  (snapshot row gone) → create 0-byte file + commit → the empty
  file pushes and the old content does NOT auto-return. ✅

The fourth case — **zeroed-then-retyped across two batches →
restored from the newer queue copy** — is covered by the unit
test "restore source: a newer pending batch's non-zero copy is
preferred over GitHub" in `sync2-manager.test.ts`. It stays at the
unit level deliberately: staging two distinct unpushed batches for
the same path against real GitHub is awkward, and the unit test
pins the exact queue-search-before-GitHub logic directly.

---

## P1 — Polish

### Harden against drain overlap spanning a plugin reload  ✅ DONE (2.0.2-beta2)

Surfaced while fixing the ref-update 422 hang (field report
2026-05-31). The 422 "not a fast forward" on PATCH /git/refs was
triggered by *something* setting the branch head to our own
deterministic commit SHA before our PATCH landed — i.e. the same
batch pushed twice. On a single device with one deviceLabel +
fixed `batch.createdAt`, the commit is fully deterministic
(tree + parent + message + author date), so two pushes collide on
the same SHA and the second PATCH is non-ff.

The fail-fast fix makes this self-recover (next drain reconciles,
no hang), so this is no longer user-visible. But the *root* — two
drains running at once — shouldn't happen given the `running`
re-entrant guard. The likely escape hatch is a drain that spans a
plugin reload (the BRAT-style disable+enable): the old instance's
interval/drain overlapping the new instance's startup pulse, two
guards, two drains.

**DONE (2.0.2-beta2)** — two cooperating guards, no marker files:

1. `onunload` calls `sync2Manager.cancelDrain()` as its first action
   (before `stopSyncInterval()` clears the timer): the OUTGOING
   instance aborts its in-flight drain cleanly (abortRequested,
   checked between batches/files) rather than crashing on the
   worker that `onunload` also terminates.

2. The startup sync is no longer fired the instant layout is ready —
   it waits `STARTUP_SYNC_DELAY_MS` (1.5 s). Across a disable+enable
   reload this gives the outgoing instance's drain teardown time to
   settle before the INCOMING instance starts its own, closing the
   overlap window. On a cold start the wait is imperceptible. The
   timer is cleared in `onunload` so it can't fire on an unloaded
   instance. No marker-file bookkeeping needed.

Even if an overlap somehow still occurs, the ref-update 422
fail-fast (§4.1) makes it self-heal invisibly: the loser's PATCH
fails in one attempt, the next drain reconciles + reuses the
already-pushed commit.

**Not pursued:** a cross-instance `.drain-lock` marker with a stale-
timeout. It would close the last theoretical sliver (an in-flight
HTTP call completing after cancelDrain) but adds per-drain I/O and a
fragile timeout (a long legit push vs a crashed-drain stale lock).
The two guards above + fail-fast cover the realistic cases. Revisit
only if field evidence shows a genuine cross-instance race. Do NOT
"fix" it by de-determinising commits — the deterministic SHA is
load-bearing for resume/idempotency (the "reuse parent commit"
path).

### Token-expiry surface in Settings  ✅ DONE (2.0.2-beta2)

The TokenExpiredModal opens at most once per hour, so a user whose
token expired between modal showings only saw a generic "Last
error" line. Two Settings surfaces now carry an actionable
token-help box (a shared affordance with two link buttons —
GitHub token page + README walkthrough):

1. **GitHub sync status section** — when the last drain error was a
   401/403, a help box appears under the error line.
   `DrainStatus.lastError` gained an `isAuthError` flag
   (`recordDrainError` detects `AuthError` / a 401|403 status) so
   the section surfaces the box without re-parsing the message.

2. **Test connection** — the help box appears below the probe
   result on a 401/403, AND proactively whenever any required
   credential field (token / owner / repo / branch) is empty —
   even before the user clicks Test. On first launch every field
   is empty, so a newcomer opening Settings immediately sees the
   two key links and knows where to go.

Shared component: `src/sync2/views/token-help.ts`
(`GITHUB_TOKENS_URL`, `PLUGIN_README_URL`, `renderTokenHelpBox`).
TokenExpiredModal refactored to import the URLs from there so all
three surfaces (modal, drain-status, Test) stay in one source of
truth. Box visibility is live: the four credential-field
`onChange` handlers + the Test outcome both call
`refreshTokenHelp()`.

---


## P2 — Backlog

### `attemptAutoMerge`-side mergeFn dedup  ✅ DONE (2.0.2-beta2)

Landed as the minimal variant (commit `534ac74`). The three
`attemptAutoMerge` call sites (pull, push-reconcile, resolution-
synthesis) each inlined an identical `mergeFn: (o,b,t) =>
this.workerClient.mergeText(...)` — a drift hazard. Hoisted to a
single pre-bound private arrow field `Sync2Manager.mergeViaWorker:
MergeTextFn`; the sites pass `mergeFn: this.mergeViaWorker`.

NOT lifted into `attemptAutoMerge`'s signature as a constructor-
level engine dependency (the original framing). That framing
claimed it would let test/production "share more configuration" —
but they intentionally DON'T: unit tests use the default
synchronous `mergeText` (no worker), production routes through the
worker (off-main-thread, SYNC2 §8). The per-call `mergeFn?`
parameter stays as the public opt-in seam; the change only dedups
the production wiring.

