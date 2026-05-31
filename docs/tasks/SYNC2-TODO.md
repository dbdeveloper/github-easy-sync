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

### Corruption-resilience integration scenarios  (remaining)

Integration tests under `tests/integration/scenarios/sync2/corruption/`:
- Zero-byte local + non-empty remote → restored from GitHub, no
  0-byte push; remote unchanged.
- Zeroed-then-retyped across two batches → restored from the
  newer queue copy.
- Brand-new 0-byte file (no snapshot history) → pushed as a
  legitimate empty file.
- **Intentional empty via delete+recreate**: delete file + commit
  (snapshot row gone) → create 0-byte file + commit → the empty
  file pushes and the old content does NOT auto-return.

---

## P1 — Polish

### Token-expiry surface in Settings drain-status

Right now the TokenExpiredModal opens once per hour; the Settings
drain-status section keeps showing "Last error" generically. Add
a dedicated red banner ("GitHub token expired — click to renew")
in the drain-status section that links to the same modal. So even
if the modal-throttle has elapsed, the user sees the actionable
state.

#### Status
---


## P2 — Backlog

### `attemptAutoMerge`-side mergeFn deferred resolution

Currently `attemptAutoMerge` takes an optional `mergeFn` that
defaults to the sync `mergeText`. Sync2Manager passes the
WorkerClient-backed async wrapper. Consider lifting `mergeFn` to a
true dependency on the engine layer rather than per-call, so
test/production paths share more configuration.

