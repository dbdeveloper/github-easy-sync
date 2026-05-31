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

### Token-expiry surface in Settings drain-status

Right now the TokenExpiredModal opens once per hour; the Settings
drain-status section keeps showing "Last error" generically. Add
a dedicated red banner ("GitHub token expired — click to renew")
in the drain-status section that links to the same modal. So even
if the modal-throttle has elapsed, the user sees the actionable
state.

### BRAT-style auto-reload after pull (synced plugins on mobile)

When `syncConfigDir = true` (or when the `Sync plugins data.json`
gate is on for a specific plugin), an updated `main.js` /
`manifest.json` for some plugin under
`<configDir>/plugins/<id>/` may land on the device via the pull
step. Without an explicit reload, Obsidian keeps running the OLD
code from memory — the user has to disable + re-enable the
plugin by hand, which they often forget. BRAT solves this by
calling Obsidian's internal `app.plugins.reloadPlugin(id)` after
each install/update; we should mirror that.

Public Obsidian API: `app.plugins.reloadPlugin(pluginId: string)`
— deprecated in name but stable for years; what BRAT and the
Community Plugins store both use under the hood.

#### Trigger detection

At the end of a successful drain, walk the just-pulled paths for
the `<configDir>/plugins/<id>/(main.js|manifest.json|styles.css|
data.json)` shape; collect the affected plugin IDs. For each ID
where the plugin is currently enabled in
`this.app.plugins.enabledPlugins`, schedule the update protocol
below.

#### Multi-file update protocol (paranoid — main.js as atomic commit point)

The naive "rename each file in sequence" approach risks an
inconsistent mid-update state where some plugin files are new
and some old. Obsidian could pick up the half-state on a reload
and crash. The fix: treat main.js as the **atomic commit point**
of the update. Phases:

  Phase 1 — STAGE: for every incoming file, write
    `<plugin>/<basename>.<ext>.sync-tmp` (the existing transient
    staging shape; the sweep already drops Path A orphan
    sync-tmp on next onload if Phase 1 crashes).

  Phase 2 — MARKER: drop a zero-byte
    `<plugin>/.<id>.update-pending.` marker (leading + trailing
    dot — same shape rules as the modify-in-place marker in
    §19.1). The marker's presence is the recovery signal:
    "Phases 3-5 are in progress; complete forward."

  Phase 3 — BACKUP: for every file that will be replaced,
    rename `<plugin>/<basename>.<ext>` →
    `<plugin>/<basename>.sync-bak.<ext>`. Skip main.js in this
    phase.

  Phase 4 — PROMOTE non-main: for every file EXCEPT main.js,
    rename `<basename>.<ext>.sync-tmp` → `<basename>.<ext>`. At
    this point manifest.json, styles.css, etc. are all new on
    disk but the plugin in memory is still old (main.js is
    still old).

  Phase 5 — PROMOTE main.js: rename `main.js.sync-tmp` →
    `main.js`. **This is the atomic commit.** Before this
    rename Obsidian still loads the old plugin code; after it,
    Obsidian loads the new code. There is no half-state where
    the running code disagrees with main.js on disk.

  Phase 6 — CLEANUP: backup main.js to `main.sync-bak.js` (we
    skipped it in Phase 3 because main.js was still in use as
    the running code's source), remove the marker, remove all
    `.sync-bak` files (or keep them for the rollback window —
    see below).

  Phase 7 — RELOAD: schedule `setTimeout(() =>
    app.plugins.reloadPlugin(id), 500)`. The 500 ms gives the
    in-flight `await drain` stack frame time to unwind. Notice:
    `"Plugin <id> updated — reloading"`.

The phase ordering matters. **main.js is renamed LAST** so the
invariant "running code matches main.js on disk" is preserved
through every possible crash window.

#### Recovery sweep (runs in our plugin's onload, BEFORE we touch
anything else)

For each plugin dir under `<configDir>/plugins/<id>/` where a
`<plugin>/.<id>.update-pending.` marker exists:

  a. If `<plugin>/main.js.sync-tmp` is present →
     - Phase 5 didn't run. Other-file sync-tmp may or may not
       still be present.
     - Rename remaining .sync-tmp → originals (skip main.js
       intentionally — it's the LAST in normal order).
     - Rename main.js.sync-tmp → main.js (atomic commit).
     - Remove the marker.
     - Remove .sync-bak files (or keep for rollback window).
     - Schedule reloadPlugin(id).

  b. If main.js.sync-tmp is NOT present (Phase 5 already ran or
     this is github-easy-sync re-loaded by Obsidian after
     Phase 5+6 worked but our reloadPlugin call never fired):
     - All originals are new. Nothing to do for the swap.
     - Remove marker.
     - Remove .sync-bak files (or keep).
     - If the plugin is OUR plugin (github-easy-sync, the one
       we just re-entered into), Obsidian already picked us up
       fresh — no reload needed. Just log the recovery.

#### Self-update — protecting github-easy-sync from itself

The user's question: "If we update OUR OWN plugin and we crash
mid-update, who recovers us?"

Answer: the symmetry of the protocol IS the recovery. Two cases:

  Case A — crash BEFORE Phase 5 (main.js still old on disk).
    Next Obsidian launch: OLD main.js loads → OLD code runs.
    OLD code's onload runs the recovery sweep above. Sweep
    finds marker + main.js.sync-tmp present → completes Phase
    5 forward, then schedules reloadPlugin. RELOAD now picks
    up the NEW code cleanly. We self-recover from old code.

  Case B — crash AFTER Phase 5 (main.js is new on disk).
    Next Obsidian launch: NEW main.js loads → NEW code runs.
    NEW code's onload runs the recovery sweep. Sweep finds
    marker + no main.js.sync-tmp → just cleans up marker and
    .sync-bak (Phase 6 leftovers). No reload needed; we're
    already running the new code.

In both cases the plugin self-heals from its OWN code
(whichever code main.js dictates). No external rescue is
needed.

#### Rollback safety net

Keep `.sync-bak` files for 24 hours after a successful update
(controlled by `<plugin>/.<id>.update-applied-at.txt` timestamp).
If the new version of github-easy-sync (or any plugin) has a
bug that breaks the plugin's enable path, the user can either:

  - Manually rename `.sync-bak` files back to originals via
    the Files app on mobile / Finder on desktop, then disable +
    re-enable in Settings.

  - Or invoke our own "Rollback last plugin update" command,
    which walks the plugin dir for `.sync-bak` files, renames
    them back, and calls reloadPlugin. The command is gated
    behind a confirmation modal (this clobbers the live
    plugin state).

The 24-hour retention is automatic and per-plugin. After 24 h
the next sweep removes the `.sync-bak` files. Users who want
permanent rollback can disable the auto-cleanup via Settings.

#### Other-plugin reload (any installed plugin OTHER than us)

Straightforward — same Phase 1-7 sequence applies, but Case A /
Case B recovery is run by OUR plugin's onload sweep (since the
victim plugin may not have a working onload after a crash):

  - Walk all `<plugin>/<id>/.<id>.update-pending.` markers.
  - For each: run recovery sweep.
  - If recovery completes Phase 5, also call reloadPlugin(id).
  - For each affected plugin ID, surface a Notice
    `"Reloaded N plugins: <list>"`.

Catch: if our own plugin crashes BEFORE we got to recover the
victim, the victim stays broken. Mitigation: the victim's
onload-fail Notice from Obsidian will prompt the user to
investigate; the user can then run our "Recover broken
plugins" command, which is the same sweep callable from the
command palette without needing a successful drain first.

#### Tests

- Unit (mock-obsidian): test the trigger-detection logic
  (pulled-path walk + ID extraction + enabledPlugins gate)
  against a fake app object. Each phase's crash window
  exercised separately — the file-state matrix is finite and
  enumerable.

- Integration: each crash window mirrored as a "leave the
  filesystem in shape X, restart, assert recovery completes
  correctly" test. mock-obsidian's adapter is fs-backed; the
  setup just writes the partial state and the assertion is on
  the post-sweep filesystem state. No real `reloadPlugin` —
  the test stubs it and asserts it would have been called.

- End-to-end: optional — would require a second plugin
  installed on the int-test repo. Defer until field demand.

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
