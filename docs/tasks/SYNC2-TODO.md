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

### Size-collapse heuristic (>90% shrink → conflict)

Adjacent to the zero-byte guard. When a file shrinks by more than
~90% of its previously-known size, treat it the same way: register
as conflict, surface to the user. The cutoff is a pragmatic
heuristic — typing a section out shrinks files by 30-50% routinely,
so 90% is a clear "this didn't happen organically" signal.

Settings field: `sizeCollapseThresholdPercent` (default 90, range
50-99). Disabled (set to 0) for users who legitimately bulk-truncate.

### Corruption-resilience integration scenarios

Three integration tests under `tests/integration/scenarios/sync2/corruption/`:
- Zero-byte local + non-empty remote → conflict registered, no push.
- 90% shrink + previously-larger remote → conflict registered.
- Brand-new 0-byte file (no snapshot history) → normal push allowed.

---

## P1 — Polish

### Split-mode confirmation modal on second [Sync] click

Stage 7 plan §7. When `syncStartsWithCommit:false` AND a sync is
in flight, the second click on the Sync ribbon should open a
confirmation modal ("A sync is in progress. Stop it?"). Today the
click is a no-op (the modal isn't wired up); Settings → GitHub
sync status `[Stop sync]` is the workaround.

### Stuck-batch passive Notice (> 5 min)

When a drain has been running for more than 5 minutes (network
slow, large fixture, etc.), surface a passive Notice with the
elapsed time. Settings drain-status section already shows this
live; the Notice is for users who don't have Settings open.

### Per-file Notice during drain

"Reconciling X/N: <path>" Notice that updates as the reconcile
loop progresses. Subscribes to the same `drainStatusChanged`
callback the Settings page uses.

### Pending-commits badge follows whichever ribbon icon is visible

Right now the unsent-commits count badge is bolted onto the
`[Sync]` ribbon icon (per the Stage 7 §5.1 rule: "pending network
work belongs visually near the network action"). That assumption
breaks for legitimate configurations the user surfaced:

- `Sync strategy: On interval` + `[Sync]` ribbon icon HIDDEN +
  `[Commit]` ribbon icon VISIBLE — the user commits manually and
  the interval timer takes care of sync. They never click Sync;
  hiding its icon is reasonable. But they ALSO lose visibility
  into how many commits are queued, because the count lives on
  the hidden icon.

The fix is a single placement rule:

  - `[Sync]` visible → count badge on `[Sync]`.
  - `[Sync]` hidden AND `[Commit]` visible → count badge on
    `[Commit]`.
  - Both hidden → no badge anywhere. (Fully automatic
    commit+sync every N minutes, OR hotkey-driven workflow —
    either way the user has chosen no-icon UX.)

Implementation:
- `refreshRibbonPendingBatchesBadge(depth)` in main.ts becomes
  the central dispatch. It picks the right icon based on the two
  settings (`showSyncRibbonButton`, `showCommitRibbonButton`) and
  writes the badge onto the chosen one, clearing any badge on
  the other.
- The setting onChange handlers for both toggles call into the
  same dispatch so flipping toggles re-renders the badge
  immediately.
- Existing call sites (`onQueueDepthChanged`, the initial paint
  in `showSyncRibbonIcon`) stay; they hit the dispatch which
  routes correctly.

### Token-expiry surface in Settings drain-status

Right now the TokenExpiredModal opens once per hour; the Settings
drain-status section keeps showing "Last error" generically. Add
a dedicated red banner ("GitHub token expired — click to renew")
in the drain-status section that links to the same modal. So even
if the modal-throttle has elapsed, the user sees the actionable
state.

### `data.json` migration code (if user base grows past one person)

The 2.0.2-beta rename (`autoCommitOnSync` → `syncStartsWithCommit`,
`accumulateOfflineSyncs` → `consolidateCommits`) currently relies on
a one-time log + Notice. The user is expected to update each
device's data.json by hand. This works for the maintainer's
two-device setup but won't scale. ~10 lines of code in
`loadSettings` to translate the old keys.

### README.md screenshots

The `#github-token-setup` anchor exists; the section below is text-
only. Add screenshots for:
- The fine-grained PAT permissions screen (Contents + Metadata
  toggles).
- The "copy this token immediately" page after Generate.
- The plugin settings tab with the token pasted in.

The TokenExpiredModal links straight to this anchor — every user
who hits an expired token lands on this section, so the screenshots
have high value.

---

## P1 — Worker orchestra follow-ups

### On-device perf validation

`tests/perf/perf-cpu-*` measure on Node desktop. The absolute
thresholds (RECONCILE_AUTO_MERGE_LIMIT default 1 MB; Stage 4 Worker
thresholds at SHA 100 KB / BASE64 2 MB / MERGE 100 KB) need to be
re-measured on:
- Capacitor Android on the slowest target phone (Pixel 6 Pro as a
  reasonable mid-tier baseline).
- Capacitor iOS.
- Electron on macOS and Windows.

Plan: a TEMPORARY Settings button (same pattern as the Stage 6
CORS feasibility test) that runs the perf matrix on the device and
writes results to the plugin log. Strip the button before final
ship; commit the device baselines into `tests/perf/README.md`.

### Push-side SHA-first blob existence check

Stage 5 plan §6. Before `createBlob` uploads bytes for a path,
query `GET /repos/.../git/blobs/{sha}` via the network worker. On
hit, reference the existing blob in the tree without re-uploading.
Saves bandwidth on the rare-but-real case where new local content
happens to match an existing blob from another path in the repo.

### Stage 7 unit tests for new branches

- `syncStartsWithCommit` master toggle: each value drives the
  expected entry point in `plugin.sync()`.
- `showCommitRibbonButton`: ribbon icon appears / disappears on
  toggle.
- Command-palette entries: `commit-local` / `upload-to-github`
  trigger the right engine method.
- TokenExpiredModal: throttled to once per hour; opens on
  AuthError; doesn't open on other error classes.

### Stream-fetch large blobs instead of full materialisation

Stage 5 plan §11. For multi-MB files, stream the blob via
ReadableStream instead of materialising the whole base64 string in
memory. Less peak RSS on phone for large attachments. Worker has
fetch + ReadableStream available natively.

### Pre-push confirmation modal for dramatic size drops

Adjacent to the size-collapse heuristic above but on the PUSH side
rather than the conflict side. When a push batch would replace a
large remote file with a much smaller local one, optionally pop a
confirmation modal. Useful for users who edited a markdown file
heavily and want a sanity check before push.

---

## P2 — Backlog

### Diff3 size-threshold → diff2 editor delegation

When a 3-way text merge is above the auto-merge threshold (so the
engine would currently skip it), route it to the in-editor diff2
flow instead of just pushing ours. Lets the user resolve big-file
divergences interactively. Depends on the `diff2` branch landing.

### `attemptAutoMerge`-side mergeFn deferred resolution

Currently `attemptAutoMerge` takes an optional `mergeFn` that
defaults to the sync `mergeText`. Sync2Manager passes the
WorkerClient-backed async wrapper. Consider lifting `mergeFn` to a
true dependency on the engine layer rather than per-call, so
test/production paths share more configuration.

---

## Removed from scope (was in the rework plan, intentionally not done)

- **"Main drain worker" that orchestrates everything from a worker
  thread.** Vault writes are main-thread-only Obsidian APIs; any
  drain worker would have to round-trip every write back to main,
  eliminating the parallelism win. The main thread stays as the
  thin orchestrator that dispatches CPU/network to workers and
  performs vault mutations.
- **Filesystem-based inter-worker communication.** Transferable
  ArrayBuffers are zero-copy and `.push-queue` already serves as
  the durable filesystem channel. Adding additional worker-to-worker
  file coordination adds concurrency control + cleanup logic for no
  measurable gain.
- **Marker file for atomic-rename strategy.** The marker is needed
  for modify-in-place (which has no `.sync-bak` as a signal); the
  rename strategy already has `.sync-bak` as the in-flight signal.
  A second marker would be redundant.
