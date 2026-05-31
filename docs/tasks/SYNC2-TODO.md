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

#### Update protocol — uniform for all plugins

Same approach for OUR plugin AND for any other affected plugin —
no special-casing of github-easy-sync. The protocol:

  1. Write each incoming file to its `<basename>.sync-tmp.<ext>`
     sibling (the existing transient staging shape; the sweep
     already drops Path A orphan sync-tmp on next onload).

  2. For each file: if the filesystem supports atomic rename
     (POSIX — Linux, macOS, Capacitor Android-on-Chromium,
     verified at install time), `atomic-rename
     <basename>.sync-tmp.<ext>` → `<basename>.<ext>`. Otherwise
     fall back to the two-step:
       - `rename <basename>.<ext>` → `<basename>.sync-bak.<ext>`
       - `rename <basename>.sync-tmp.<ext>` → `<basename>.<ext>`
       - `remove <basename>.sync-bak.<ext>`
     If a crash hits between the two renames, the user's
     plugin won't load and they have to reinstall via BRAT or
     Community Plugins. We accept that — it's a rare event on
     a healthy filesystem, and the failure mode is "plugin
     unavailable until reinstall," not "data loss."

  3. After all files swapped: `setTimeout(() =>
     app.plugins.reloadPlugin(id), 500)`. The 500 ms gives the
     in-flight `await drain` stack frame time to unwind. Notice
     `"Plugin <id> updated — reloading"`.

  4. Done. No marker file, no rollback slot, no recovery
     sweep beyond the existing Path A sync-tmp orphan cleanup.

#### Self-update of github-easy-sync — minimal bootloader at the
start of `main()`

This is the ONE special case. Our plugin updates itself, which
means the running code is the OLD code at the moment we apply
the swap. To make sure the NEW main.js gets used, the start of
our own `main()` (the entry point Obsidian calls on plugin
enable) acts as a thin "conditional bootloader." Not a separate
file — just a few lines that run before anything else.

The 9-step bootloader logic:

  1. At start of `main()`, before any other initialisation,
     check if `<plugin>/main.sync-tmp.js` exists in our own
     plugin directory.

  2. If NO → continue normal onload. Done.

  3. If YES → compute SHA of `main.js` AND
     `main.sync-tmp.js`.

  4. If SHAs are EQUAL → the running code is already the new
     version (Obsidian picked it up via a fresh enable; the
     sync-tmp is leftover). Delete `main.sync-tmp.js` and
     continue normal onload.

  5. Edge case: `main.sync-bak.js` ALSO present alongside
     sync-tmp. Normally impossible (sync-bak shouldn't survive
     a successful enable that left main.js intact). But it
     CAN happen if the user reinstalled via BRAT / Community
     Plugins mid-recovery. Treatment: delete BOTH sync-tmp
     and sync-bak, continue normal onload (whatever the user
     just installed is the source of truth).

  6. If SHAs DIFFER and the filesystem supports atomic rename
     → `atomic-rename main.sync-tmp.js` → `main.js`.

  7. If SHAs DIFFER and the filesystem does NOT support atomic
     rename (Windows / Capacitor iOS quirks) → execute:
       - `mv main.js main.sync-bak.js`
       - `mv main.sync-tmp.js main.js`
       - `rm main.sync-bak.js`
     If a crash strikes between the two `mv` calls, the plugin
     won't enable on next launch. User reinstalls via BRAT /
     Community Plugins. Rare event, acceptable failure mode.

  8. Call `app.plugins.reloadPlugin('github-easy-sync')` ONLY
     IF main.js was actually replaced in step 6 or 7 (skip
     when step 4 short-circuited with no rename).

  9. Done. New main.js is now both on disk AND about to be
     loaded by Obsidian's next plugin lifecycle pass.

The 5-step "ordinary plugin" protocol above handles every
plugin INCLUDING ours up to the point where the swap completes.
This 9-step bootloader is the additional layer that handles the
"running code IS the code being swapped" recursion specifically
for github-easy-sync's own main.js.

#### Status

Landed in 2.0.2-beta2 (commit `bcc2cbe` for the BRAT-style auto-
reload protocol, commit for sweep-triggered reload + sweep
appliedPaths). Tests: 942/942 unit pass.

The five enhancements brainstormed during design (multi-slot
rollback `.old`/`.new`, "Boot previous version" toggle, build-
time SHA embedding, two-file architecture, multi-version
history) were CONSIDERED AND REJECTED — not because they're
"deferred to later" but because they're not load-bearing for
our threat model:

- Multi-slot rollback / "Boot previous version": user cancelled
  during design ("відміняємо"). If a new plugin version is
  broken, the user reinstalls via BRAT / Community Plugins.
- Build-time SHA: the bootloader's runtime SHA comparison
  between `main.js` and `main.sync-tmp.js` covers the integrity
  case adequately. Build-time SHA would only protect against
  bit rot when no sync-tmp is present, which is vanishingly
  rare on modern filesystems with built-in checksums.
- Two-file architecture: our bootloader region (~30 lines at
  the top of `main()`) is rewritten in full whenever the file
  changes — atomic rename replaces the WHOLE file, not just a
  body region. The "preserve bootloader region across updates"
  property that splits would provide isn't load-bearing here.

The previous "Paranoid bootloader pattern (FSM with mess-state
recovery)" spec exploration is preserved in commit `9840383`
(SYNC2-TODO docs commit before simplification) for archeology.

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
