# Sync2 — TODO

Leftover work from the 2.0.2-beta rework (Stages 1-9 of
`SYNC2-WORKER-REORG.md`, now removed). Items are grouped by
priority. Each entry has enough context to start without re-reading
the whole rework plan.

---

## P0 — Safety guards (next focused commit batch)

### Zero-byte file → conflict, not push

When a local file shrinks to 0 bytes but the remote SHA points at a
non-empty blob, the engine should **register the path as a conflict
and refuse to push**. Zero-byte files in a notes vault are almost
always a corruption signal (Desktop incident, May 2026): a file is
rarely intentionally truncated to empty, and the cost of a false
positive (one extra confirmation modal) is far smaller than the
cost of a false negative (silently overwriting useful content).

Acceptance:
- Reconcile sees `ours.size === 0` AND `theirs.sha !== empty-blob-sha`
  AND previous snapshot recorded non-zero size → skip push, register
  conflict, log decision.
- Snapshot tracks previous `size` so a brand-new 0-byte file the
  user just created still gets through.
- Unit test pinning the snapshot-state matrix (no snapshot / snapshot
  with old size / snapshot with same size).


### Corruption-resilience integration scenarios

Two integration tests under `tests/integration/scenarios/sync2/corruption/`:
- Zero-byte local + non-empty remote → conflict registered, no push.
- Brand-new 0-byte file (no snapshot history) → normal push allowed.

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

