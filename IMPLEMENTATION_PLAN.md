 # Implementation Plan — Sync Performance & UX Refactor

This document captures the agreed-upon redesign of the sync flow. It is the contract for the upcoming refactor; commit messages should reference its etaps.

## Status snapshot (as of 2026-05-08)

- **Etap 0–5**: landed in full.
- **Etap 6**: core landed (5-phase lifecycle, bootstrap-from-remote, cascade rebase, three command-palette entries, custom-message modal, progress Notice, accumulateOfflineSyncs, parametric integration suite over both engines, P1–P5 perf doubles). **Stub still in place**: the wired `onConflict` callback in `main.ts` returns the conflict-marked content unchanged and shows a Notice — there is no diff/resolve modal yet. Tracked separately as Etap 6.5 below.
- **Etap 6.5**: text conflict resolver UI — **landed**. Per-file modal (`Resolve now` / `Later` / `Merge into one` for markdown / `Defer ALL remaining`), `ConflictStore` with `.conflicts/<id>/` persistence (base+theirs snapshots survive force-pushed history), `ConflictView` workspace leaf hosting `DiffPane` (CM6 `MergeView` wrapper), `ConflictStatusBar` widget (`🔀 N`), pane labels GitHub/{deviceLabel}, root `<vault>/.gitignore` invariant block forces `*.conflict-from-*` siblings to never push, vault delete/rename listeners auto-close conflicts, ms-precision commit timestamps + always-trailing `(deviceLabel)` suffix prevents multi-device collisions and is parseable from any sync2 commit on GitHub. 17 sync2 unit tests + 4 integration tests against real GitHub (defer→sibling-delete, merge-into-one, pending-blocks-push, multi-copy-pair-resolution).
- **Etap 6.6**: text canonicalization (LF universal, no BOM, trailing-NL invariant) — **landed**. Pull-side normalize on bootstrap + applyRemoteAddOrModify (clean + merge paths), push-side normalize + write-back in PushQueue, auto-republish via synthesized FileChange after findChanges. `decodeBase64String` uses `ignoreBOM: true` so the BOM survives base64 decode into normalize. 8 unit tests in `sync2-manager.test.ts` ("text canonicalisation on pull"), 9 in `push-queue.test.ts` ("text canonicalisation"), 6 integration tests under `tests/integration/scenarios/sync2/normalization/` (pull-CRLF, pull-BOM, push-local-CRLF, idempotent-double-sync, binary-byte-exact, multi-device-convergence) — all green against real GitHub.
- **Etap 7**: **landed**. Legacy `SyncManager`, `events-listener`, `gitignore-cache`, `metadata-store`, `sync-state`, `views/init-decision-modal`, `views/conflicts-resolution/`, `benchmark.ts` deleted. `experimentalSync2` setting removed (no longer needed). Settings narrowed to sync2-only fields. `main.ts` rewritten as ~400 LOC sync2-only orchestrator. Legacy integration tests + parametric harness deleted; `tests/integration/helpers.ts` trimmed to env+GitHub-API+fault-injection helpers. `tests/utils.test.ts`, `tests/metadata-store.test.ts`, `tests/gitignore-cache.test.ts`, `tests/sync-state.test.ts` deleted. Sync2 perf-doubles deleted (they used the deleted parametric `engine-factory`).
- **Plugin not renamed**: per project decision, `github-gitless-sync` plugin id / repo directory stays unchanged. Manifest file, log file, invariant block markers, and commit-message defaults already use `github-easy-sync` naming where it matters internally; the plugin id stays for backward compat.
- **Known follow-ups after cutover** (not blocking):
  - Bare-repo bootstrap (Sync2Manager processBatch Case 1) — fails with 409 because Git Data API needs ≥1 ref; needs a Contents-API seed-commit step like legacy. The 4 bare-repo integration tests are `describe.skip`-ped.
  - Wider integration coverage — ~10 use cases that lived in legacy tests have no sync2 equivalent yet (adoption flows, multi-device convergence, resume-mid-upload, J-series auth/network errors, K-series manifest corruption).

## Why this plan exists

Current sync of an unchanged vault takes 20–30 seconds. Profiling showed three dominant costs:

1. Double-fetch of `getRepoContent` (~95 KB) and the manifest blob (~95 KB) on every sync, regardless of whether anything changed.
2. `findDivergedPaths` and `determineSyncActions` each read+SHA-1 every local file, yielding ~13 s of CPU on a 260-file vault.
3. `POST tree` ships the **entire** remote tree (~611 KB) every push, even when one file changed.

The user's profile is single-writer-dominant: a desktop and a phone, ~95% of syncs are push-only with no remote changes. Pulls are rare and small. Files are mostly markdown 1 KB – 300 KB; conflicts come up only when the user edits the same file on both devices and forgets.

Conclusion: REST is fine; the bottleneck is design, not protocol.

## Strategy: parallel development, then cutover

The legacy `sync-manager.ts` is a 2300+ line orchestrator with seven init-actions, ten sticky manifest fields, and conflict logic spread over three modules. Refactoring it incrementally would mean every change is gated by backward compatibility with paths the new design does not need.

Instead, we **build sync2 from scratch alongside legacy** and switch over in one commit when sync2 covers everything. During development a hidden setting `experimentalSync2` selects the engine.

### Layout

```
src/
├── sync-manager.ts            ← legacy, untouched
├── gitignore-cache.ts         ← legacy matcher + invariant block, untouched
├── events-listener.ts         ← legacy, untouched
├── metadata-store.ts          ← shared (filename was renamed in Phase 1.5a)
├── github/client.ts           ← shared transport
├── gi.ts                      ← shared matcher (used by sync2 only)
├── utils.ts                   ← shared pure helpers
├── logger.ts                  ← shared
├── settings/                  ← shared; gains experimentalSync2 + commit templates
└── sync2/
    ├── types.ts               ← FileSnapshot, FileChange, QueueBatch, MergeResult
    ├── sync2-manager.ts       ← orchestrator: syncAll / syncFile / resumeQueue
    ├── snapshot-store.ts      ← persistent (path → {sha, mtime, size}) for ChangeDetector
    ├── change-detector.ts     ← finds added/modified/deleted via stat-cache
    ├── push-queue.ts          ← .push-queue/<ts>/vault/ persistent batches
    ├── tree-builder.ts        ← delta-tree (only changed entries via base_tree)
    ├── three-way-merge.ts     ← server-fetched base + node-diff3
    └── commit-templates.ts    ← {date}/{filename}/{path} substitution
```

`src/sync2/` does not import anything from `src/sync-manager.ts`, `src/gitignore-cache.ts`, or `src/events-listener.ts`. Shared modules (`metadata-store`, `github/client`, `gi`, `utils`, `logger`) are fair game because they are pure persistence/transport/matching. Ideas borrowed from legacy are restated locally — no `import` of legacy implementation.

### Cutover

When sync2 passes its own integration suite and the existing one (parameterised over both engines), the cutover commit:

1. Deletes `src/sync-manager.ts`, `src/gitignore-cache.ts`, `src/events-listener.ts`.
2. Moves `src/sync2/*` → `src/`. (Or keeps the namespace if that reads cleaner.)
3. Strips `experimentalSync2` from settings.
4. Extracts the legacy `gitignore-cache.ts` invariant-block side-effect into a tiny standalone `src/gitignore-invariants.ts` (only the rewrite-on-onload + `pluginCreatedGitignores`/`preExistingGitignoreShas` tracking). Sync2 itself does not need this — it is independent of sync state.

After cutover the `experimentalSync2` flag is gone; sync2 is the only engine.

## Architectural decisions (locked)

- **No `.cache/` directory.** A per-file pre-edit snapshot mirror is not needed: GitHub stores commits indefinitely (absent force-push), so the base for any 3-way merge can be fetched on demand at conflict time via `getBlob` against `lastSyncCommitSha`. One less stateful directory, one less reconcile loop, one less migration.
- **`.push-queue/` is the only stateful new directory.** Each Sync click materialises a snapshot of changed files into `.push-queue/<timestamp>/vault/`, and a background runner pushes those snapshots to GitHub one commit at a time. The runner is independent of the editor.
- **REST stays.** No `isomorphic-git`, no native pack protocol, no GraphQL migration. Each was evaluated; none gives proportional return for this user's traffic profile and effort budget.
- **3-way merge uses `node-diff3`.** Imported as an npm dependency (~10 KB minified, mobile-clean). Base content fetched live from GitHub at conflict time using `lastSyncCommitSha`.
- **Three sync actions surfaced as Obsidian commands.** Hotkeys and Vim ex-bindings are **NOT** wired by sync2 — users assign them via Obsidian's hotkey panel or external plugins (e.g. Commander, vimrc-support). Sync2 only registers the commands; binding policy is the user's.
  - **Action 1** — full sync (`syncAll`, everything to/from GitHub).
  - **Action 2** — sync the active file only (`syncFile(activePath)`).
  - **Action 3** — sync active file with a custom commit message (modal prompt → `syncFile(activePath, msg)`).
- **Settings change at cutover:** drop `deviceName`. Add `commitMessageAll` and `commitMessageFile` template strings with placeholders `{date}`, `{filename}`, `{path}`. **No migration from old `deviceName`** — sync2 just uses the literal defaults `"Sync from Obsidian {date}"` and `"Update {filename} ({date})"`; users with mixed-device commit conventions edit the templates by hand.
- **Offline accumulation:** setting "акумулювати послідовні зміни в одному коміті коли нема зв'язку з GitHub" (`accumulateOfflineSyncs: boolean`, default off). When on and the runner is offline, subsequent Sync clicks merge into the latest pending queue directory rather than spawning new ones; the eventual push is one commit.
- **Manifest goes server-less in sync2.** Sync2 does not push `github-easy-sync-metadata.json` to GitHub. Its state lives entirely in local manifest + the `.push-queue/`. State reconstruction on a fresh device is `getRepoContent` + `getCommit` to learn `lastSyncCommitSha`/`lastSyncTreeSha`, then a one-shot rebuild of the local snapshot store.
- **Old `github-sync-metadata.json` on the remote is left alone.** Migration from `github-gitless-sync` is documented in README; the user removes it manually if they care. We do not touch other tools' artifacts (mirroring how the legacy plugin does not delete `.git/` left by `obsidian-git`).

## `.push-queue/` directory layout

```
.push-queue/
  20260503093823777/
    .in-progress              # marker: this batch is currently being pushed
    .meta.json                # { commitMessage, parentCommitSha, parentTreeSha, createdAt }
    deleted-paths.txt         # newline-separated paths to delete (optional)
    vault/                    # snapshot root; mirrors actual vault structure
      Folder/Subfolder/note.md
      attachments/img.png
  20260503094112301/
    .meta.json
    vault/
      Folder/note.md
```

The `vault/` sub-root is mandatory: without it, vault files named `.meta.json`, `.in-progress`, or `deleted-paths.txt` would collide with control files.

`.in-progress` is created at upload-start, removed on success, and read on `onload` to detect crash recovery.

## Sync2 manifest shape

The local manifest under sync2 (`<configDir>/github-easy-sync-metadata.json`) is a dedicated schema, not a stripped legacy one:

```ts
{
  // Branch state at the moment of this device's last successful sync.
  lastSyncCommitSha: string | null;
  lastSyncTreeSha: string | null;

  // Per-file snapshots. Used by ChangeDetector to skip read+SHA on
  // unchanged files.
  files: {
    [path: string]: {
      remoteSha: string;   // git blob SHA last seen on remote for this path
      mtime: number;       // local mtime when remoteSha was recorded
      size: number;        // local size when remoteSha was recorded
    }
  };

  // Pending queue batch IDs not yet pushed. Lets onload resume cleanly
  // without a directory walk.
  pendingQueueSyncs: string[];
}
```

No `dirty`, no `justDownloaded`, no `lastModified`, no per-device gitignore tracking. Those legacy fields had reasons in the legacy flow that don't apply here.

## Cascading conflict resolution across queued batches

Scenario: queue holds `Q1` (snapshot V1 of `note.md`) and `Q2` (snapshot V2). The runner is uploading `Q1`. GitHub reports a conflict against version `Z` already on the server. The user resolves V1+Z → V1.mod through the diff modal.

V2 was authored on top of V1 in the editor. It contains V1 plus the user's later edits (call it `delta_T3`). After resolve, GitHub holds V1.mod. If we push V2 unchanged, we lose `delta_resolve`.

Fix: when resolve completes for `Q1`, run `pushQueue.rebaseFile()` on every later queued directory that contains the same path. For each such queue:

- `base = V1` (from `Q1` snapshot, before resolve),
- `ours = V2` (from `Q2` snapshot),
- `theirs = V1.mod` (resolve output).
- 3-way merge → `V2.mod`.
- Write `V2.mod` into `Q2/vault/note.md`.

If `delta_T3` and `delta_resolve` touch different parts of the file, the merge is clean and silent. Otherwise a second conflict modal fires — rare but possible.

## Gitignore is a two-way mute

A path matched by any `.gitignore` rule is **invisible to sync2 in both directions**, no exceptions:

- ignored file modified locally → push ignores it.
- ignored file deleted locally → push ignores the deletion (it was never tracked).
- ignored file added on remote → pull ignores it (does not download).
- ignored file deleted on remote → pull ignores it (does NOT delete the local copy).
- ignored file modified on remote → pull ignores it.

This mirrors git: once `.gitignore` covers a path, the tool stops thinking about it. A file that the user keeps locally for personal reasons must survive any remote-side changes silently.

`ChangeDetector.findChanges()` filters via `isSyncable` before any stat or read. Pull-side filters (in Sync2Manager.processQueue) check the same predicate before applying remote-driven adds/modifies/deletes to disk.

When a `.gitignore` itself changes (via vault edit, pull, or invariant-block rewrite at onload), the next call to `ChangeDetector.findChanges()` reconciles the snapshot store: paths that became ignored are dropped silently (Pass 2; X policy — remote untouched, mirroring git); paths that became syncable surface as `added` (Pass 1). There is no separate "recheck" procedure — gitignore consistency and snapshot consistency share the same one-method walk.

**Mandatory integration tests for this rule** (to land alongside Etap 2 / Etap 6):

- `gitignore/local-edit-of-ignored-file.test.ts` — file matched by `.gitignore`; user edits it; sync produces no commit.
- `gitignore/local-delete-of-ignored-file.test.ts` — same setup; user deletes it locally; sync produces no commit.
- `gitignore/remote-delete-of-ignored-file.test.ts` — file ignored locally, present on remote, removed on remote (e.g. via web UI or another tool); sync does **not** delete the local copy.
- `gitignore/remote-modify-of-ignored-file.test.ts` — file ignored locally, modified on remote; sync does not overwrite local.
- `gitignore/remote-add-of-ignored-file.test.ts` — file matching local `.gitignore` rule appears on remote; sync does not download.
- `gitignore/became-ignored.test.ts` — file was syncable, `.gitignore` updated to cover it; subsequent push leaves the remote copy alone, snapshot drops the entry.
- `gitignore/became-syncable.test.ts` — file was ignored, `.gitignore` updated to expose it; subsequent push picks it up as a new file.
- `gitignore/rename-syncable-to-ignored.test.ts` — rename moves a tracked file into an ignored zone (e.g. `drafts/note.md` → `archive/note.md` where `archive/*` is gitignored). Push commits a delete of `drafts/note.md`; the file remains on disk under `archive/note.md`, no longer tracked.
- `gitignore/rename-ignored-to-syncable.test.ts` — rename pulls a previously ignored file into a syncable zone. Push commits the new path as `added`.
- `gitignore/rename-syncable-to-syncable.test.ts` — rename within syncable zones. Push commits one tree containing delete(old) + add(new) sharing the same blob SHA — GitHub renders this as a rename.
- `gitignore/rename-cycle.test.ts` — same path goes syncable → ignored → syncable. After the second rename, sync2 tracks it freshly as `added`.

These tests live under `tests/integration/scenarios/sync2/gitignore/`. They do not parameterise over the legacy engine (legacy passes them through different paths and not all five scenarios are even reachable on legacy without manual surgery).

### Rename semantics across the gitignore boundary

Rename crosses four cases. **All four resolve correctly through `findChanges()` alone** — no special hook needed — because the gitignore-mute rule is keyed off the *current* path, not the old one. After a rename, the old path is referenced only by the snapshot store and the file no longer exists there; whether mute applies is decided by whether *that path* is ignored.

| Old → New | findChanges output | Effect on remote |
|---|---|---|
| syncable → syncable | `deleted(old)` + `added(new)` | tree carries delete+add; matching blob SHAs let GitHub render it as a rename |
| syncable → ignored | `deleted(old)` | file removed from remote; local copy lives on under its new path, untracked |
| ignored → syncable | `added(new)` | new file appears on remote |
| ignored → ignored | nothing | no commit |

Why no `handleRename`: in case 2, the snapshot at `oldPath` (still in a syncable region by definition) sees no file behind it → emits `deleted(old)`. This is exactly the desired result. In case 3, the new path has no snapshot → `added(new)`. In case 4, both paths are ignored and `findChanges()` skips them. The only actor needed is `findChanges()` itself.

This also means Sync2Manager does **not** need to register a `vault.on("rename")` listener for sync correctness. (Other reasons might still motivate one — e.g. UX surfaces — but not the rename↔gitignore interaction.)

## Two layers, one consistency story

Two distinct responsibilities; do not conflate them.

**Layer A — gitignore actuality.** Owned by GI. Answers `ignored(path)` against the live `.gitignore` state on disk. Stat, mtime tracking, cache invalidation are all GI's internal business; outside callers never look at them. The only public surface is the predicate.

**Layer B — snapshot consistency.** Owned by `SnapshotStore` + `ChangeDetector.findChanges()`. Reconciles the in-memory map of tracked files against what's on disk. Calls `gi.ignored()` as one of its cheap checks; doesn't manage GI's cache.

The connection between them is a single function call. A's freshness is its own contract; B trusts the answers and reconciles itself accordingly.

### Layer A (GI internals)

GI auto-stats each `.gitignore` it has loaded when a path under that directory is queried, with a small **cooldown** so the 100+ sequential `ignored()` calls during one `findChanges()` produce at most one stat per loaded level. Stats hitting an unchanged mtime are no-ops; stats showing a change reload that level.

**Why the cooldown.** Without it, every `ignored()` call would translate into a `vault.adapter.stat` per gitignore level on the path. On 260 files × 3 typical levels (root + configDir + self-plugin) and 1–3 ms per stat on mobile, that adds up to ~1–2 seconds of overhead per sync **even when nothing changed**. The cooldown makes the steady-state cost a flat 3 stats per sync run regardless of how many `ignored()` calls happen inside it.

Constant `STAT_COOLDOWN_MS = 500` ms — long enough to dedupe stats inside one sync, short enough that "edit `.gitignore`, click Sync immediately" still picks up the change at the start of the next run.

`Node` fields added: `mtime` (for change detection) and `lastStatAt` (for the cooldown).

Public API stays the same — `ignored()` / `ignoredAsync(path, reader)`. The reader signature gained a mtime-aware variant; the legacy content-only reader still works (it just can't take advantage of the mtime fast path).

`gi.invalidate(parentDir)` is still public, used by callers that *know* a `.gitignore` just changed and want to skip the cooldown wait. Routine "did the disk move?" cases are handled by auto-stat alone.

### Layer B (snapshot reconciliation)

`ChangeDetector.findChanges()` is one method, two passes:

```
Pass 1 — vault → output:
  for each TFile in vault.getFiles():
    if !isSyncable(path):           # asks GI
      continue
    seen.add(path)
    stat = await adapter.stat(path)
    snap = store.get(path)
    if !snap:
      out.push({ kind: "added", … })
      continue
    if stat.mtime === snap.mtime && stat.size === snap.size:
      continue                       # cache hit
    content = await adapter.readBinary(path)
    sha = sha1Git(content)
    if sha === snap.remoteSha:
      store.set(path, { ...snap, mtime: stat.mtime, size: stat.size })
      continue                       # touched but unchanged
    out.push({ kind: "modified", path, …, previousRemoteSha: snap.remoteSha })

Pass 2 — snapshot → cleanup or "deleted":
  for each path in store.paths():
    if seen.has(path):
      continue
    if !isSyncable(path):
      store.remove(path)             # path became ignored → drop silently
      continue
    out.push({ kind: "deleted", path, previousRemoteSha: store.get(path).remoteSha })
```

This handles every case `recheckAfterGitignoreChange()` used to handle: `becameIgnored` paths drop in Pass 2; `becameSyncable` paths surface in Pass 1 as `added`. No separate procedure.

## Invariant gitignore blocks in sync2

Sync2 maintains canonical invariant blocks in **two** locations.

### `<configDir>/.gitignore` — invariant block at the top, user-editable below

The invariant block is the deny-list for per-device state. Sync2 prepends it to the file (or rewrites it in place if it's already there). User content below the closing marker is left strictly untouched.

```
# ===== github-easy-sync invariants — DO NOT EDIT =====
# Editing this block triggers a rewrite to canonical on next load.

# Per-device state — never propagate between machines.
github-easy-sync-metadata.json
workspace.json
workspace-mobile.json
community-plugins.json
# ===== end of invariants =====
```

**Recommended defaults below the invariants** are seeded **only** when sync2 creates the `.gitignore` from scratch (the file did not exist beforehand). If the user already had their own `<configDir>/.gitignore`, sync2 only injects the invariant block on top — the user's existing rules stay verbatim.

```
# Recommended defaults — feel free to edit.

# Logs (covers the plugin's own github-easy-sync.log and any other *.log).
*.log

# Plugin folder allowlist — by default sync only the four canonical files.
plugins/*/*
!plugins/*/
!plugins/*/data.json
!plugins/*/main.js
!plugins/*/manifest.json
!plugins/*/styles.css
```

### `<configDir>/plugins/<our-id>/.gitignore` — fully managed by sync2

This file is **rewritten in full** on every check, regardless of prior content. Strict allowlist:

```
*
!main.js
!manifest.json
!styles.css
!.gitignore
```

The `!.gitignore` line is what lets the allowlist itself propagate to other devices.

### What sync2 does NOT touch

- `<configDir>/plugins/.gitignore` — explicitly **not** managed. Other plugins' territory.
- Anywhere in the repository outside `<configDir>/` — root `.gitignore` and friends are pure user content.

### Trigger and freshness

The invariant check runs **before every Sync2 operation that may touch files under `<configDir>/`** — at the start of `syncAll()` and at the start of `syncFile(path)` when `path` is under `.obsidian/`.

**Cheap by default.** Per-file mtime + content-hash of each invariant gitignore is cached in `data.json` under `sync2InvariantState`:

```ts
sync2InvariantState: {
  configDirGitignore:    { mtime: number; hash: string };  // .obsidian/.gitignore
  selfPluginGitignore:   { mtime: number; hash: string };  // .obsidian/plugins/<self>/.gitignore
}
```

For each of the two files, the algorithm:

```
liveStat = await vault.adapter.stat(path)
if liveStat == null:
  // file missing — write canonical, record fresh mtime+hash
else if liveStat.mtime === recorded.mtime:
  // cache hit — nothing to do
else:
  liveContent = await vault.adapter.read(path)
  liveHash = sha1Git(liveContent)
  if liveHash === recorded.hash:
    // touched-but-unchanged — refresh recorded.mtime only
  else:
    // real edit — repair (splice for configDir, overwrite for self-plugin),
    // record fresh mtime+hash
```

Steady-state cost (user didn't touch the gitignores): **2 stats, 0 reads, 0 hashes** per sync — a few ms even on mobile.

### Why `vault.adapter.stat` and not `vault.on(...)` events

Obsidian's high-level Vault API ignores dotfiles — `.gitignore` is invisible to `vault.getFiles()` and to the `modify`/`create`/`delete` event bus. We can't subscribe to changes on these files through Obsidian.

`vault.adapter`, however, is the raw FS wrapper (NodeFS on desktop, Capacitor FS on mobile). It **does** see dotfiles, and `adapter.stat()` returns a real `mtime` from the underlying filesystem. So our mtime+hash check is the correct primitive — it picks up edits made through any external means (text editor on desktop, file manager on mobile, `git`-flavoured tools), independent of Obsidian's index.

### Self-write feedback loop — keep `sync2InvariantState` in sync

When sync2 itself pushes one of these gitignores as part of a batch (the user added rules to `<configDir>/.gitignore` and clicked Sync), the push pipeline ultimately writes the file's bytes back to disk after a successful commit (in `recordSync`'s re-stat path) — and that resets `mtime`.

Without further care, the next sync would see "mtime drift", read the file, compute hash, find it matches `recorded.hash`, and refresh just `recorded.mtime`. Self-correcting, but pointless: an extra read + hash on every sync that follows a gitignore push.

**Fix:** when `recordSync(path)` runs for either of the two invariant files, sync2 also updates `sync2InvariantState[file].mtime` to the new stat result and `.hash` to the freshly-pushed content's git blob SHA, atomically with the snapshot write. The next sync's mtime check is then a clean cache hit. One extra line in `recordSync`'s gitignore branch.

## Sync2Client interface

A thin abstraction over the GitHub REST surface that Sync2Manager actually uses. The real `GithubClient` from `src/github/client.ts` satisfies this interface; tests inject a stub. Keeping it narrow means the test stubs don't need to model retries, settings, or logging — only HTTP semantics.

```ts
interface Sync2Client {
  // Push pipeline
  createBlob(args: { content: string; encoding?: "utf-8" | "base64"; retry?: boolean })
    : Promise<{ sha: string }>;
  createTree(args: { tree: { tree: NewTreeRequestItem[]; base_tree?: string }; retry?: boolean })
    : Promise<string>;        // → tree SHA
  createCommit(args: { message: string; treeSha: string; parent?: string; retry?: boolean })
    : Promise<string>;        // → commit SHA
  updateBranchHead(args: { sha: string; retry?: boolean }): Promise<void>;

  // State queries
  getBranchHeadSha(args?: { retry?: boolean }): Promise<string>;     // 404 → throw status=404
  getCommit(args: { sha: string; retry?: boolean })
    : Promise<{ tree: { sha: string } }>;

  // Pull pipeline
  compare(args: { base: string; head: string; retry?: boolean })
    : Promise<{
        status: "ahead" | "behind" | "identical" | "diverged";
        files: Array<{
          filename: string;
          status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
          sha: string | null;
          previous_filename?: string;
        }>;
      }>;
  getContentsAtRef(args: { path: string; ref: string; retry?: boolean })
    : Promise<{ content: string; sha: string } | null>;  // null on 404
}
```

`OnConflictCallback` lives next to it — fired when the 3-way merge hits an overlap. UI plugs in here:

```ts
type OnConflictCallback = (args: {
  path: string;
  ours: string;
  base: string;
  theirs: string;
  conflictMarkedContent: string;
}) => Promise<string>;  // returns the user's resolved content
```

`Sync2Logger` is the same shape as legacy `Logger` (`info`/`warn`/`error`, all async, optional `data`). Mostly used for `PHASE …` markers and one-line error records that sit alongside legacy `github-easy-sync.log` entries.

## Sync2 lifecycle: one syncAll, step by step

A single `syncAll()` walks five phases. Reading top-to-bottom is the contract; changing the order changes the semantics.

```
1. Local change detection
   - findChanges() walks vault.getFiles() (cached stat) under the
     mtime watermark + isSyncable predicate. Pass 1 reports
     added/modified, Pass 2 reports deleted, drops snapshot rows
     for paths that became ignored.
   - Output: FileChange[] = the user's intent at click-time.

2. Snapshot the user's intent into the queue
   - enqueueOrMerge(changes): copies the bytes of each changed
     file into <plugin>/.push-queue/<ts>/vault/<path>; writes
     .meta.json with parent SHAs from the *current* snapshot
     store. Once this returns, the user can keep editing — the
     batch represents the moment of the click.
   - With accumulateOfflineSyncs and a non-in-progress batch on
     disk, the new changes fold into that batch instead of
     creating a new one.

3. Pull metainfo (compare)
   - getBranchHeadSha(); if HEAD === lastSyncCommitSha, skip the
     compare call entirely (no remote drift).
   - Otherwise compare(lastSyncCommitSha, currentHead) returns
     the list of remote-side changes.
   - 404 on compare (force-pushed history, GC'd commit) is
     swallowed; the next push reconciles against currentHead.

4. Apply remote changes to the local vault
   - Each remote-side change is classified against the path's
     local situation (queued? locally clean? locally dirty?
     ignored? hardcoded-blocked?):
       * remote add/modify, local clean    → fetch blob, write
                                              locally, recordSync.
       * remote add/modify, local dirty    → fetch blob, fetch
         (path NOT in queue)                  base-version, 3-way
                                              merge, write
                                              locally; if conflict,
                                              the onConflict modal
                                              is the resolver.
       * remote add/modify, path IS in     → re-target the queued
         queue                                snapshot through the
                                              same 3-way merge
                                              (cascading rebase
                                              comes later in the
                                              same path).
       * remote modify, local deleted      → keep local deletion;
         (the deletion is queued)             do NOT recordSync —
                                              the queued delete
                                              propagates on push.
       * remote delete, local clean        → adapter.remove, then
                                              recordDeletion.
       * remote delete, path IS queued     → conflict surfaced via
         (with new content)                   the queued snapshot;
                                              local resurrection
                                              wins on push.
       * remote change, ignored locally    → do nothing (two-way
                                              mute).
   - Blob fetches happen ONLY for paths that survived the
     classification — we never download bytes that won't end up
     written somewhere.
   - At the end, lastSync moves forward to currentHead (and the
     just-fetched tree SHA from getCommit).

5. Drain the queue
   - For each pending batch, oldest-first:
     - markInProgress.
     - reconcileBatchAgainstHead — if currentHead drifted *again*
       between phase 3 and now, run a second 3-way merge per
       text file, cascade-rebase later batches that share the
       path, and updateMeta to re-target the batch onto the new
       head.
     - buildTreeEntries — text inline, binary via createBlob.
     - createTree(base_tree=batch.parentTreeSha, tree=entries).
     - createCommit(parent=batch.parentCommitSha).
     - updateBranchHead.
     - recordSync per file, recordDeletion per deletion,
       setLastSync, setLastCommitMtime, save snapshot store.
     - delete batch directory.
```

The user's mental model: "Sync = push my work + bring me up to date." Phase 1+2 capture the push. Phase 3+4 do the pull. Phase 5 actually flushes the push to GitHub. Splitting "metadata" (compare) from "content" (blob fetch) in phase 3+4 means we never download a blob we don't need: paths that match local exactly, ignored paths, paths the user just deleted — all skip the bytes.

## Force-push / commit-removed handling

Assumption: the repo is driven by this plugin >99% of the time, force-push is not part of the normal flow. When it does happen (or when GC removes a referenced commit), historical lookups fail.

Behaviour: if `getBlob` for a base version returns 404/422, the runner falls back to a 2-way diff modal. No crash, no hang — a notice tells the user "Cannot recover historical version (commit removed); manual conflict resolution required." Sync continues with whatever the user decides.

Same fallback if `compare` against `lastSyncCommitSha` returns 404.

## Etaps

Each etap is a self-contained chunk that ships independently. Etaps 0–5 are fully landed; Etap 6 is core-landed (resolver UI is the remaining piece, tracked as Etap 6.5); Etap 7 (cutover + plugin rename completion) is the only outstanding work. See "Status snapshot" at the top of this document for the live state.

### Etap 0 — Foundation tweaks on legacy *(landed)*

- Phase 1: `lastSyncCommitSha` / `lastSyncTreeSha` added to manifest schema (`MetadataStore.load` migrates old files; three success sites in `sync-manager.ts` populate them; three strip sites remove them before push).
- Phase 1: early-exit branch in `syncImpl` — `getBranchHeadSha` first, skip the ~190 KB `getRepoContent` + manifest blob fetch when HEAD hasn't moved.
- Phase 1.5a: manifest filename renamed to `github-easy-sync-metadata.json`. Old file ignored. References across sources and tests updated.

These changes benefit legacy users immediately and cost sync2 nothing.

### Etap 1 — Sync2 skeleton *(landed)*

- `src/sync2/` created.
- `src/sync2/types.ts` — `FileSnapshot`, `FileChange`, `QueueBatch`, `MergeResult`, `CommitMessagePlaceholders`.
- `src/sync2/commit-templates.ts` — pure `applyTemplate` + `DEFAULT_COMMIT_MESSAGE_ALL` / `DEFAULT_COMMIT_MESSAGE_FILE`. Tested.
- `src/sync2/sync2-manager.ts` — `Sync2Manager` skeleton with three throwing methods. Tested.
- `src/gi.ts` — `ignoredAsync`, `preloadAsync`, `invalidate` added. Sync core untouched. Tested (38 GI cases).
- `experimentalSync2?: boolean` setting added (default false), unused yet.

### Etap 2 — ChangeDetector + SnapshotStore *(landed)*

- `src/sync2/snapshot-store.ts` (~200 LOC): persistence over `<configDir>/github-easy-sync-metadata.json`. Owns the sync2 manifest schema. Migration silently drops legacy fields (`dirty`/`justDownloaded`/`lastModified`); legacy `files[path].sha` maps to sync2's `files[path].remoteSha`. Also stores `invariantState` (mtime+hash) used by Etap 7's invariants module.
- `src/sync2/change-detector.ts` (~315 LOC): two-pass `findChanges()` plus `findChangeForPath()`, `recordSync()`, `recordDeletion()`, `checkSyncable()`. `isSyncable` rule = hardcoded deny + `gi.ignoredAsync`.
- Unit tests: `tests/sync2/snapshot-store.test.ts`, `tests/sync2/change-detector.test.ts`. Detailed contract is preserved verbatim under "Etap 2 plan" below as historical record.

### Etap 3 — PushQueue *(landed)*

`src/sync2/push-queue.ts` (~385 LOC). Persistent FIFO of batches. Public API:
- `enqueue(changes, meta)` → batch id; copies snapshots into `<configDir>/plugins/<id>/.push-queue/<ts>/vault/...` and writes `.meta.json`.
- `list()` → batch ids in order, oldest first.
- `read(id)` → `QueueBatch`.
- `markInProgress(id)` / `clearInProgress(id)`.
- `delete(id)`.
- `mergeIntoLatestPending(changes)` for the offline-accumulate path.
- `overwriteFile(id, path, content)` — replaces a single file's snapshot in an existing batch. Sync2Manager runs the 3-way merge itself and hands the resolved content here, so this stays content-only — no merging logic in PushQueue.
- `updateMeta(id, { parentCommitSha?, parentTreeSha? })` — re-targets the batch's parent SHAs after a remote-side reconcile.
- `readFile(id, path)` — fetches "ours" bytes for the merge.

Unit tests: `tests/sync2/push-queue.test.ts` covers enqueue/list/delete round-trips, in-progress markers across re-construction, `mergeIntoLatestPending` semantics, `overwriteFile` for text+binary, `updateMeta` partial updates.

### Etap 4 — TreeBuilder *(landed)*

`src/sync2/tree-builder.ts` (~125 LOC). Wraps `client.createTree({ base_tree, tree })` so callers ship only changed entries. Pure logic over `FileChange[]` → `NewTreeRequestItem[]`. Unit tests in `tests/sync2/tree-builder.test.ts` plus integration round-trip via the parametric scenarios.

### Etap 5 — ThreeWayMerge *(landed)*

`src/sync2/three-way-merge.ts` (~50 LOC) + `src/sync2/node-diff3.d.ts` ambient types. `node-diff3@^3.2.0` listed in `package.json`. Public:
- `mergeText(base, ours, theirs): MergeOutcome` — clean or conflict-marked (uses `excludeFalseConflicts`).

**Deviation from original plan**: `fetchBase()` is **not** part of this module. Base-content fetching against `lastSyncCommitSha` is delegated to `Sync2Manager` (it uses the `Sync2Client.getContentsAtRef` surface). Tests: `tests/sync2/three-way-merge.test.ts`.

### Etap 6 — Sync2Manager full + UX *(core landed; conflict resolver UI deferred to Etap 6.5)*

Landed:
- `src/sync2/sync2-manager.ts` (~1030 LOC) — `syncAll`, `syncFile(path, customMessage?)`, `resumeQueue`, full 5-phase lifecycle, bootstrap-from-remote (`bootstrapIfNeeded`), cascading rebase across queued batches (`cascadeRebase`), invariants enforcement at lifecycle entry points, `onProgress` Notice, force-push fallback for missing-base history.
- Three command palette entries wired in `src/main.ts`: `sync-files`, `sync-current-file`, `sync-current-file-with-message`. No hotkeys, no Vim ex-bindings — users wire those themselves through Obsidian's settings or external plugins like Commander.
- Custom-message modal at `src/sync2/views/commit-message-modal.ts`.
- Settings UI in `src/settings/tab.ts`: `experimentalSync2` toggle, `commitMessageAll`, `commitMessageFile`, `accumulateOfflineSyncs`. `deviceName` is still on the legacy panel; sync2 reads only its own template strings.
- Parametric integration harness: `tests/integration/scenarios/parametric/engine-factory.ts` runs the same scenario against both engines (`incremental-upload`, `idle-sync-benchmark`). Engine-specific scenarios (queue persistence, gitignore mute, bootstrap-from-bare) live under `tests/integration/scenarios/sync2/`.
- Perf doubles for sync2: `tests/perf/p1..p4-sync2.test.ts` plus a new `p5-idle-sync.test.ts`.

Not yet wired (the only remaining piece of the originally-scoped Etap 6 work):
- The `onConflict` callback supplied to `Sync2Manager` from `main.ts` is currently a stub: it returns the conflict-marked content unchanged and shows a Notice telling the user to resolve markers and re-sync. The merge engine itself (Etap 5) is fully functional — only the UI surface is missing.

### Etap 6.5 — Text conflict resolver UI *(landed)*

Replace the stub `onConflict` callback in `main.ts` with a real, mobile-friendly conflict resolution flow built on `@codemirror/merge` (Obsidian's own CM6 stack — ~25 KB extra bundle, no platform branching).

#### Three resolution options (per file)

When sync2 detects a text-content conflict that 3-way merge could not auto-resolve, sync2 shows a **per-file** modal:

```
┌────────────────────────────────────────────────────┐
│  Sync conflict (N of M): <vaultPath>               │
│                                                    │
│  [ Resolve now ]                                   │
│  [ Later ]                                         │
│  [ Merge into one ]      ← markdown files only     │
│  ─────────────────────────                         │
│  [ Defer ALL remaining ]                           │
└────────────────────────────────────────────────────┘
```

- **Resolve now** — opens the Conflict View tab (below) and focuses this file. Returning from there proceeds to the next conflict's modal.
- **Later** — captures the (base, theirs) snapshot to `.conflicts/<id>/`, writes the sibling file `<basename>.conflict-from-<deviceLabel>-<isoTs>.<ext>` to the vault, increments the status-bar counter. The next conflict's modal fires.
- **Merge into one** — markdown-only (see "File-type matrix" below); inlines the conflict-copies under the original via `> [!info]` callouts and finishes this file silently. Next conflict's modal fires.
- **Defer ALL remaining** — bulk version of "Later" for the rest of this sync's conflicts. Single click closes the loop without further per-file prompts. The reason for this being the only "bulk" option: the other two require a per-file *content* judgment, but deferral does not.

Per-file modal (instead of one modal listing all conflicts): scales to many conflicts without scrolling-list UX, and lets the user mix resolutions ("now" for the important file, "later" for the boring one). A list-of-files modal looks tidy with 3 conflicts but breaks at 30 — and forces a single resolution mode for everyone in that list.

#### File-type matrix

| File type | Modal? | Available actions |
|---|---|---|
| Markdown (`.md`) | yes | Resolve now / Later / **Merge into one** / Defer all |
| Other text (`.json`, `.yml`, `.css`, `.js`, …) | yes | Resolve now / Later / Defer all (Merge-into-one is **disabled** — config files don't survive callout-style inlining) |
| Binary, currently | no | Direct sibling-copy creation, no modal — diff doesn't make sense for arbitrary bytes |
| Images (future etap) | yes | Resolve now (image-diff side-by-side preview) / Later / Defer all — same modal pattern, different diff renderer |

#### Conflict View (the shared tool)

A new `ItemView` workspace-leaf (registered as `sync2-conflict-view`). Opens via:
- "Resolve now" button on the modal,
- Status-bar widget click,
- Command palette: `Sync2: open conflict view`.

The same view serves both "resolve now" and "later" — no UX bifurcation.

```
┌─ Conflict View ──────────────────────────────────────────────────────┐
│ ┌─ Conflicts (3) ─────┐ ┌─ note.md  vs  Phone 15:30 ───────────────┐│
│ │ ▼ note.md (2 vers.) │ │  OURS                  THEIRS            ││
│ │   • Phone 15:30 [▶] │ │ ───────────────────── ─────────────────  ││
│ │   • Tablet 18:00    │ │  # Notes              # Notes            ││
│ │ ▶ todo.md (1)       │ │ ░░folded 12 lines░░  ░░folded 12░░       ││
│ │ ▶ ideas.md (1)      │ │ ┌──── conflict block 1 ────────────────┐ ││
│ │                     │ │ │  - buy milk    │   - milk + eggs    │ ││
│ │ [Open both panes]   │ │ │ [ ours ][ theirs ][ both ]           │ ││
│ │                     │ │ └──────────────────────────────────────┘ ││
│ └─────────────────────┘ └──────────────────────────────────────────┘│
│  [◄ Prev block] [Next block ►]  [◄ Prev file] [Next file ►]         │
└──────────────────────────────────────────────────────────────────────┘
```

- Diff engine: `@codemirror/merge` (CM6 official). Fold unchanged regions, free-form editing on either side, native gutters. Custom widget overlays the per-chunk action bar with three buttons (next paragraph).
- Per-chunk action buttons (markdown only): **ours**, **theirs**, **both**. For non-markdown text (`.json`/`.yml`/etc.) the **both** button is hidden — `>`-prefix blockquotes break those file formats. Binary/image conflicts don't use this view at all.
- Each click rewrites the same chunk in **both** panes simultaneously, so the two files progressively converge:
  - **ours** → both panes get the local version's chunk
  - **theirs** → both panes get the remote version's chunk
  - **both** → both panes get `<ours-chunk>\n` followed by the theirs-chunk with each line `>`-prefixed (standard markdown blockquote — renders as a quoted aside in the original document, never produces invalid markdown)
- After every resolution CM6 auto-rediffs; resolved chunks disappear from the diff view. Once a chunk is resolved (ours/theirs/both clicked, or hand-edited until both sides match), it becomes **regular text in both panes** — the navigation arrows (`Prev block` / `Next block`, kbd `n` / `N`) walk only the still-diverging chunks, never the resolved ones. To revisit a resolved chunk the user undoes the action (CM6 native undo, single transaction reverts both panes) or scrolls to it manually. This rule applies in both side-by-side and stacked layouts; on narrow screens, where chunks are presented one after another vertically, it's especially visible: a resolved block visually merges into the surrounding plain text and is skipped on Next.
- **Auto-finalize**: when both panes are byte-identical the conflict closes itself (no manual "Mark resolved" click needed) — sync2 deletes the sibling file, removes `.conflicts/<id>/`, and unblocks the path for the next push. Manual edits inside either pane are still allowed; the same byte-equality check fires after every keystroke.
- Multi-copies-per-file: when one `vaultPath` has several deferred conflict-copies, the left list shows them as siblings. User picks any pair → resolves → result becomes the new `vaultPath` content + that conflict-copy is deleted. Other copies remain for subsequent iteration. **2-way pair-only**, never 3+ panes.
- Responsive layout (live-switch on window resize):
  - **Wide** (≥ 768px): side-by-side ours | theirs panes — both editable with the per-chunk action bar between them.
  - **Narrow** (< 768px): stacked layout (ours above, theirs below; or unified diff with `+`/`-` markers — both look acceptable on narrow screens, the prototype picks whichever feels less cramped during testing). Action buttons stay per-chunk; keyboard navigation works the same.
  - The split adapts as the user drags the Obsidian window edge or rotates the device, not just at view-open time.
- Keyboard: `n` next block, `N` prev block, `j`/`k` next/prev file, `1`/`2`/`3` apply ours/theirs/both to the current block. Touch: action-bar buttons (44px min).

#### "Merge into one" — markdown only

The original file becomes:

```markdown
<original content as-is>

> [!info] Changing 1 — from Phone, 2026-05-08T15:30:00Z
> <conflict-copy-1 content, indented as callout body>

> [!info] Changing 2 — from Tablet, 2026-05-08T18:00:00Z
> <conflict-copy-2 content, indented as callout body>
```

Why callouts: Obsidian renders them as visually-distinct blocks, supports native folding, and the inner content stays valid markdown (search, links, embeds all work). Searchable by `Changing 1`, `Changing 2`, or `from <device>`. No `<<<<<<<` markers that could leak to GitHub. Conflict-copies are deleted; nothing remains in `.conflicts/`.

Disabled for non-markdown: a `.json` file with a callout block inside is invalid JSON. A `.css` file with `> [!info]` is not CSS. The button is hidden in the modal for any extension other than `.md`.

#### Persistence — `.conflicts/<id>/`

Path: `<configDir>/plugins/<self>/.conflicts/<id>/` — a sibling of `.push-queue/` under the plugin's own directory.

GitHub-leak protection: sync2 already rewrites `<configDir>/plugins/<self>/.gitignore` on every onload to a strict allowlist (`* / !main.js / !manifest.json / !styles.css / !.gitignore`). Etap 6.5 keeps that allowlist as-is — `.conflicts/` is implicitly blocked by the `*` line, so `meta.json`, `base.<ext>`, and `theirs.<ext>` never leak to GitHub. No new gitignore rule is needed; the invariant is already in place from Etap 7-prep work.

Layout:
```
<configDir>/plugins/<self>/
  .gitignore       # strict allowlist (already rewritten on every onload)
  .push-queue/     # Etap 3
  .conflicts/      # Etap 6.5
    <id>/
      meta.json    # { vaultPath, siblingPath, deviceLabel, ts,
                   #   baseCommitSha, theirsBlobSha }
      base.<ext>   # captured ancestor bytes from baseCommitSha tree
      theirs.<ext> # captured remote-side bytes at conflict time
```

Why store base + theirs locally: deferring a conflict is a first-class operation. By the time the user comes back (days/weeks later), `lastSyncCommitSha` has moved forward, GitHub history may have been force-pushed, and the sibling file may have been further edited. Local capture keeps the 3-way merge available indefinitely — `ours` is read live from disk, `(base, theirs)` come from `.conflicts/<id>/`.

#### Status-bar widget

Replaces the legacy "open conflicts modal" ribbon. Always-visible counter: `🔀 N` (where N = number of pending conflict-copies in `.conflicts/`). Click → opens the Conflict View tab. Hidden when N = 0.

#### Sync2Manager integration

When pending conflicts exist for a `vaultPath`, sync2 **excludes** that path from `enqueueOrMerge` until the conflict is resolved. Reasoning: pushing the file mid-resolution would commit a partially-merged version (or lose the user's deferred conflict-copy entirely). The exclusion is automatic — `findChanges()` still emits `modified`, but `enqueueOrMerge` filters paths that have a conflict record.

Resolution detection — listener in `main.ts`: `vault.on("delete", file => sync2.notifyConflictResolved(file.path))`. If the deleted file is a known sibling, sync2 deletes the matching `.conflicts/<id>/` and unblocks the original `vaultPath` for the next sync. The user's mental model: "I deleted the conflict-copy, the conflict is over."

#### Modules

| File | Approx LOC | Role |
|---|---|---|
| `src/sync2/conflict-store.ts` | ~150 | CRUD over `.conflicts/<id>/` + persistent metadata |
| `src/sync2/conflict-merge-all.ts` | ~80 | Pure: `mergeIntoOne(original, [{copy, label, ts}]) → string` (markdown callouts) |
| `src/sync2/views/conflict-modal.ts` | ~80 | Per-file modal with 3 actions + Defer-all |
| `src/sync2/views/diff-pane.ts` | ~180 | **Reusable** diff/merge component. Pure: takes `{ oursText, theirsText, isMarkdown, theirsReadOnly?, onChange, onByteEqual? }`, wraps CM6 merge view + per-chunk action bar + responsive layout. Knows nothing about conflicts, sibling files, or GitHub. Two modes via props: **merge mode** (both panes editable, auto-finalize via `onByteEqual` callback — used by conflict view) and **reference mode** (`theirsReadOnly: true`, no `onByteEqual` — user freely browses old text, selects+copies, optionally clicks per-chunk to pull bits into ours, then closes the tab manually — primary use-case for the future file history viewer). Etap 8 reuses this verbatim. |
| `src/sync2/views/conflict-view.ts` | ~120 | Thin `ItemView` orchestrator: left-side conflict list, hooks `.conflicts/<id>/` as the source of `theirsText`, passes `onByteEqual` to diff-pane that deletes the sibling + clears the store entry. |
| `src/sync2/views/conflict-status-bar.ts` | ~50 | "🔀 N" widget |
| `src/sync2/sync2-manager.ts` | ~30 | Skip pending-conflict paths in enqueue; rewire `onConflict` to spawn modal+sibling instead of returning conflict-marked text |
| `src/main.ts` | ~80 | Register leaf type, status bar, listener, 3 commands |
| `package.json` | — | `@codemirror/merge` |

#### Tests

Unit:
- `tests/sync2/conflict-store.test.ts` — round-trip, multi-id, listener-driven cleanup.
- `tests/sync2/conflict-merge-all.test.ts` — markdown callout formatting (single copy, multiple copies, empty original, copy with nested code blocks).

Integration (under `tests/integration/scenarios/sync2/conflicts/`):
- `resolve-now-clean.test.ts` — overlapping edit, choose Resolve now, accept ours-side blocks → push contains the resolved version.
- `per-chunk-both-markdown.test.ts` — markdown file with overlapping edit; click `both` on the chunk → resolved file contains ours chunk followed by `>`-prefixed theirs chunk; both panes converge to identical bytes; auto-finalize fires (no Mark-resolved click needed).
- `per-chunk-both-hidden-for-json.test.ts` — JSON file in conflict view: `both` button is not rendered; only `ours` and `theirs` are available.
- `auto-finalize-on-byte-equality.test.ts` — user manually edits both panes until they're identical → conflict auto-closes, sibling deleted, .conflicts/<id>/ gone.
- `defer-then-resolve-via-sibling-delete.test.ts` — choose Later, sibling appears in vault, user deletes it, next sync pushes ours.
- `merge-into-one.test.ts` — markdown file with two conflict-copies → merged file has two callout blocks; conflict-copies removed.
- `merge-into-one-disabled-for-json.test.ts` — JSON file conflict, modal does not show "Merge into one" button.
- `binary-skips-modal.test.ts` — PNG conflict creates sibling file directly without modal.
- `multi-copy-pair-resolution.test.ts` — file accumulates two conflict-copies via two deferrals; resolving against copy A leaves copy B available; second resolve closes the file.
- `defer-all-remaining.test.ts` — 5 conflicts, click Defer-all on the first modal → all 5 land in `.conflicts/`, no further modals.
- `pending-conflict-blocks-push.test.ts` — file with pending conflict is excluded from enqueue; resolving unblocks.
- `responsive-layout-switch.test.ts` (DOM-level, not real GitHub) — simulate window resize across the 768px threshold, assert layout switches between side-by-side and stacked without losing edit state.
- `nav-skips-resolved-blocks.test.ts` (DOM-level) — file with 3 conflict blocks; click `ours` on block 2; press `Next block` from block 1 → cursor lands on block 3, not block 2. Same for `Prev block`. Same after a `both` choice and after a hand-edit that brings the block to byte-equality.

#### Out of scope for Etap 6.5

- Image diff for binary conflicts (future feature; current behavior: timestamp-based atomic resolution + sibling copy of the loser).
- Auto-resolve-after-N-days policy.
- A "merge sibling A into sibling B" operation when the same file has multiple deferred conflicts; user resolves them as a chain instead.
- Settings toggle for git-style markers as alternative resolution mode (not asked for; keep one good UX rather than two mediocre ones).

#### Effort

~720 prod LOC + ~500 test LOC. **3–4 days** wall-clock.

### Etap 6.6 — Text canonicalization (LF universal, no BOM, trailing-NL invariant) *(landed)*

Sync2 enforces a canonical local form for all text files: **LF line endings**, **no UTF-8 BOM**, **trailing newline iff non-empty**. Pull always normalizes (non-negotiable: "локально все правильно"); push best-effort writes the canonical form to GitHub via auto-republish on detected drift. Binary files stay byte-exact — only `hasTextExtension(path) === true` is normalized.

#### Locked decisions

1. **Push-side write-back to vault.** When `PushQueue.copyFileFromVault` reads a non-canonical text file, sync2 normalizes the bytes AND writes the normalized version back to the live vault file (`vault.adapter.write(originalPath, normalized)`) before stashing the snapshot. Invariant: post-sync, the local copy IS canonical. (User-visible: paste-from-CRLF-source then Sync → local file becomes LF.)
2. **Pull-side auto-republish.** When `Sync2Manager` fetches a remote text blob and normalization changes its bytes, sync2 writes the normalized version locally AND adds the path to a `republishPaths` set. At the end of phase 4 (apply remote changes), if `republishPaths` is non-empty, sync2 enqueues a normal push batch for those paths. The next drain ships canonical bytes to GitHub. Convergence: at most one extra commit per pull-with-noise.
3. **Trailing newline only for non-empty content.** Empty file stays empty (`""` → `""`, `changed: false`). Non-empty without trailing `\n` gets one appended (`"abc"` → `"abc\n"`, `changed: true`). Multiple trailing newlines preserved verbatim.

#### Why LF universally (not platform-aware)

- Obsidian itself writes LF on every platform, including Windows.
- Modern Notepad supports LF since Windows 10 1809 (Oct 2018); every modern editor handles it.
- The SHA-tracked-snapshot architecture requires byte-identical files across devices to avoid phantom-modify cycles. Platform-aware EOL would either thrash through endless modify commits, or require EOL-blind SHA computation (which is more complexity for no user benefit).

If a real Windows-only-CRLF tool emerges later, the escape hatch is a `canonicalLocalEol: 'lf' | 'crlf' | 'platform'` setting. Default stays `'lf'`.

#### Modules to add / change

- **New `src/sync2/text-normalize.ts`** — pure `normalizeText(input: string): { content: string; changed: boolean }`. Steps: strip leading U+FEFF (UTF-8 BOM as decoded code point) → CRLF→LF → lone-CR→LF → ensure trailing `\n` if non-empty. `changed` is `true` iff output differs from input.
- **`src/sync2/push-queue.ts`** `copyFileFromVault` text branch: read → `normalizeText` → write snapshot with normalized content; if `changed`, also `vault.adapter.write(vaultPath, normalized)` to satisfy decision 1.
- **`src/sync2/sync2-manager.ts`** pull-apply path (`applyRemoteChange` or equivalent): for `hasTextExtension(path)`, normalize the fetched content before disk write; track non-canonical paths in `republishPaths`. Phase-4 epilogue: if non-empty, synthesize a `FileChange[]` for those paths and run them through the standard `enqueueOrMerge` + drain.
- **`src/utils.ts`** `hasTextExtension` — already exists, used as the gate; no change needed.

`ChangeDetector` and `SnapshotStore` need no changes. Their git-blob-SHA computation runs against on-disk bytes, which by the post-sync invariant are canonical — so SHAs are computed against the canonical form naturally.

#### Tests (sync2-only; legacy is on its way out via cutover)

- **`tests/sync2/text-normalize.test.ts`** (unit): BOM strip, BOM-only file, BOM in middle (preserved as ZWNBSP), CRLF→LF, lone-CR→LF, mixed CR/CRLF/LF, empty stays empty, non-empty trailing-NL invariant, idempotency (`normalize(normalize(x)) === normalize(x)`), pass-through cases (`changed: false`).
- **`tests/sync2/push-queue.test.ts`** (extend): non-canonical text input → snapshot is canonical, vault file is rewritten to canonical, the change-flag bubbles up so callers can see what was rewritten.
- **`tests/integration/scenarios/sync2/normalization/`** (new directory):
  - `pull-of-crlf-from-web.test.ts` — web-UI writes CRLF → first sync pulls + writes LF locally + auto-republishes → GitHub now LF.
  - `pull-of-bom-from-web.test.ts` — same for UTF-8 BOM.
  - `push-of-local-crlf.test.ts` — write CRLF locally → Sync → local file becomes LF, GitHub gets LF.
  - `idempotent-double-sync.test.ts` — second consecutive Sync after a normalize-republish is a no-op (no extra commits, no thrashing).
  - `binary-byte-exact.test.ts` — PNG round-trip is byte-exact (regression guard against accidental normalization of binaries).
  - `multi-device-convergence.test.ts` — A pushes CRLF, B pulls (sees LF locally), B's next sync is a no-op.

#### Out of scope

- Encoding detection beyond UTF-8 (Windows-1251, Big5, etc.). Obsidian doesn't support non-UTF-8 anyway.
- Per-file override (e.g., a "keep CRLF for this one file" marker). Not requested; opens a config-noise rabbit hole.
- Conversion of literal `\r\n` substrings inside markdown code blocks (e.g., user writing about line endings). Acceptable trade-off — they're treated as line endings, not as preserved bytes. Markdown-rendered output is unaffected.
- Stripping or adding final-newlines beyond the empty/non-empty rule (e.g., collapse `"abc\n\n\n"` to `"abc\n"`). Multiple trailing NLs are valid user content (paragraph spacing in markdown).

### Etap 7 — Cutover

Already in flight (these landed early, ahead of the etap proper):
- Invariant-block side-effect lives in `src/sync2/gitignore-invariants.ts`. It's wired into `Sync2Manager` directly: `enforce()` runs at the start of `syncAll()` and at the start of `syncFile(path)` when `path` is under `<configDir>/`; `notePathSelfWritten()` is called after a successful push of either managed gitignore so the cached `(mtime, hash)` doesn't drift.

Still to do at cutover:
- Flip `experimentalSync2` default to `true` (one beta release for safety).
- Delete legacy `src/sync-manager.ts`, `src/gitignore-cache.ts`, `src/events-listener.ts`.
- Move `src/sync2/*` up to `src/` (or keep the namespace if that reads cleaner — decide at cutover).
- Remove the `experimentalSync2` setting and the legacy `deviceName` row from `src/settings/tab.ts`.
- Finish the plugin rename `github-gitless-sync` → `github-easy-sync`: `manifest.json` `id`, repo directory, README. (Manifest filename, log filename, invariant block, and commit defaults already use the new name.)
- README documents migration paths from `obsidian-git` and `github-gitless-sync`.

## Bootstrap-from-remote on a fresh device

When sync2 starts on a vault that has never synced before but the GitHub branch already has commits, the first `syncAll()` would otherwise interpret all remote files as missing-on-our-side — there's no snapshot baseline. Sync2 needs an explicit one-shot bootstrap step.

**Trigger.** Inside `syncAll()`, before any other phase, sync2 checks: `lastSyncCommitSha === null && remote head exists`. If true, run bootstrap; otherwise the regular lifecycle proceeds.

**Steps.**
1. `getBranchHeadSha()` — current head.
2. `getRepoContent()` — full tree.
3. For each blob in the tree: `getBlob(sha)`, decode, write to vault, set snapshot row `{remoteSha, mtime, size}`. Skip paths blocked by `isSyncable` (hardcoded deny + gitignore — note that `<configDir>/.gitignore` may not yet exist locally; in that case GI is empty and only hardcoded rules apply).
4. `setLastSync(currentHead, currentTreeSha)`, `setLastCommitMtime(now)`, save.

After bootstrap returns, the same `syncAll()` continues with the standard lifecycle (likely a no-op now — local matches remote — but the lifecycle handles that gracefully).

**Cost.** First sync on a 260-file vault: 260 `getBlob` calls. Slow, but happens exactly once per device. We don't optimise it.

**What it doesn't do.** Bootstrap doesn't reconcile pre-existing local files against remote. Sync2's contract assumes "fresh device" means an actually fresh vault. If the user has files locally and on remote that they expect to merge, that's an adoption flow — out of scope for sync2's current design.

## Progress UI

A single Notice owns the user's eyeballs during a sync. The text adapts to the work shape:

- **One batch, normal load** (~0–10 files, none over 1 MB): just `Syncing with GitHub…`.
- **Multiple batches in the queue** (offline accumulate, resume from crash): `Syncing commit N/M with GitHub…`. If `N` stays at 1 while `M` grows across consecutive Sync clicks, the user can read the misbehaviour without a separate threshold check.
- **Heavy work, single or multiple batches** (many files OR aggregate transfer over a configurable threshold, default 5 MB): `Syncing commit N/M: file G/F with GitHub…` — per-file progress while bytes flow.

The trigger between "normal" and "heavy" runs once when the batch is enqueued, by tallying `sum(file.size)` of upload and the comparable value for pull. No flag, no throttling — just two text shapes from one Notice.

## Etap 8 (future, post-cutover) — Per-file history viewer

Goal: let the user open any tracked file and browse the GitHub commits that touched it, with a side-by-side diff between the current local copy and any picked historical commit. Useful when a previous version had an idea that was overwritten and the user wants it back.

**Primary use-case is "look + copy + close", not "merge".** The user usually just wants to see how the file looked before, select a fragment, copy it out, and dismiss the diff. Per-chunk action buttons are available but secondary; free copy-paste from the historical pane is the dominant interaction.

**Reuses Etap 6.5 building blocks:**
- `diff-pane.ts` — opened in **reference mode**: `theirsReadOnly: true`, no `onByteEqual` callback. The historical pane is immutable (so nothing the user does here can ever push to GitHub by accident); the local pane is editable. Per-chunk **theirs** restores the chunk from history into ours; **ours** discards local edits in that chunk; **both** (markdown only) keeps ours followed by `>`-prefixed historical chunk.
- `Sync2Client.getContentsAtRef` — already in the interface, used as-is to fetch the historical content.

**One new API method on `Sync2Client`:**
```ts
listFileCommits(args: {
  path: string;
  perPage?: number;       // default 30
  page?: number;          // default 1
  retry?: boolean;
}): Promise<Array<{
  sha: string;
  message: string;
  author: string;
  date: string;
}>>;
```
Wraps `GET /repos/{owner}/{repo}/commits?path={path}`. Pagination follows the same shape as the rest of the client; tests inject a stub that returns a fixed list.

**New modules (Etap 8 only):**

| File | Approx LOC | Role |
|---|---|---|
| `src/sync2/views/file-history-view.ts` | ~150 | `ItemView`: left-side commits list (with infinite-scroll pagination), top-bar shows currently-viewed commit's metadata, right side hosts `diff-pane` in reference mode |
| `src/main.ts` | +20 | Register leaf, command "Sync2: open file history" (acts on the active file) |
| `src/github/client.ts` | +30 | `listFileCommits` method, real implementation against the GitHub API |
| Tests | ~200 | Unit: `listFileCommits` pagination; integration: open history, switch commits, restore-via-theirs writes to disk and the next sync pushes the restored content |

**Not promised in Etap 8:**
- Annotation/blame mode (per-line "this line came from commit X").
- Multi-commit "compress range" diff. The viewer is current-vs-one-commit only.
- Undo of a restore — once user pulled a chunk via `theirs`, they go through Obsidian's native undo or load history again.

**Integration with sync2 lifecycle:**
- Restoring from history just modifies the local file. No special sync2 flag.
- `findChanges` picks it up as `modified` on the next syncAll → push goes through normal pipeline (incl. Etap 6.6 canonicalisation).
- If the user has pending conflicts on this file, the file history view is read-only on the local pane too (we don't want to overwrite the conflict-resolution-in-progress state). Sync2Manager can expose a single bool "has pending conflict for path" that the view consults at open.

**Effort estimate (when scheduled):** ~200 prod LOC + ~200 test LOC, ~2 days. Independent of the cutover (Etap 7) — can ship before or after.

## Out of scope for this plan

- Native git pack-protocol push.
- Gzip request bodies (cherry-on-top).
- ETag caching for read endpoints (cherry-on-top after Etap 1).
- GraphQL migration.
- ~~Revoke / version-history feature~~ — moved into Etap 8 (planned, post-cutover, design above).
- Diff preview inside the "show changed files" modal (Etap 6 ships list-only).
- **Status bar item for sync2.** Legacy has one; sync2 will add one once a clear purpose is established. Deferred — listed here so it isn't silently lost.
- **README migration guides for legacy users** (from `obsidian-git`, from `github-gitless-sync`). Deferred to post-cutover.

## Effort estimate

| Etap | Production lines | Test lines | Wall-clock |
|---|---|---|---|
| 0. Legacy foundation | ~150 | ~80 | landed |
| 1. Sync2 skeleton | ~120 | ~120 | landed |
| 2. ChangeDetector + SnapshotStore | ~515 actual | ~730 actual | landed |
| 3. PushQueue | ~385 actual | ~445 actual | landed |
| 4. TreeBuilder | ~125 actual | ~260 actual | landed |
| 5. ThreeWayMerge | ~50 actual | ~135 actual | landed |
| 6. Sync2Manager core + UX | ~1030 actual | ~1525 actual | landed (no resolver UI) |
| 6.5. Text conflict resolver UI | ~900 actual | ~500 actual | landed |
| 6.6. Text canonicalization | ~150 actual | ~430 actual | landed |
| 7. Cutover (no plugin rename) | ~3000 deletions, ~400 main.ts rewrite | ~3000 test deletions | landed |
| **Total remaining** | — | — | — |

LOC numbers for landed etaps are measured against `src/sync2/` and `tests/sync2/` as of 2026-05-08; they're notably larger than the original estimates, mostly because Sync2Manager grew to absorb cascade-rebase, bootstrap-from-remote, progress-Notice, and invariants-enforcement (the last of which was originally Etap 7 work).

---

# Etap 2 plan — ChangeDetector + SnapshotStore *(landed; preserved as historical contract)*

## Goal

Sync2 needs to answer "what changed since my last sync?" without reading every file from disk. ChangeDetector + SnapshotStore deliver that, with a stat-cache contract that makes "nothing changed" a single `vault.adapter.stat` call per file.

This is the foundation everything else stands on: PushQueue feeds off `FileChange[]`, TreeBuilder turns the same array into a tree, ThreeWayMerge consumes individual paths from it.

## Files

### `src/sync2/snapshot-store.ts`

Thin persistence over `<configDir>/github-easy-sync-metadata.json`. Owns the sync2 manifest schema (see "Sync2 manifest shape" above).

```ts
export class SnapshotStore {
  constructor(vault: Vault) { … }

  async load(): Promise<void>;
  async save(): Promise<void>;

  // Per-file accessors.
  get(path: string): FileSnapshot | undefined;
  set(path: string, snap: FileSnapshot): void;
  remove(path: string): void;
  paths(): string[];

  // Sync state.
  getLastSyncCommitSha(): string | null;
  getLastSyncTreeSha(): string | null;
  setLastSync(commitSha: string, treeSha: string): void;

  // Pending queue ids.
  getPendingQueueSyncs(): string[];
  setPendingQueueSyncs(ids: string[]): void;
}
```

Loads on construction (or via explicit `load()`); persists via `save()` after meaningful state transitions. In-memory mutation between save calls is safe — sync2 is single-threaded inside the runner.

Migration: if the file doesn't exist, start fresh (empty `files`, null commit/tree SHAs, empty queue). If it exists but is from legacy (has `dirty`, `justDownloaded`, etc.), drop those fields silently — sync2 doesn't need them. The `files[path].sha` field from legacy maps cleanly to `files[path].remoteSha` in sync2 schema; we read the legacy field on load and store it under the sync2 name.

### `src/sync2/change-detector.ts`

Pure logic; depends only on `Vault`, `SnapshotStore`, `GI`, and `utils.sha1Git` (not legacy syncManager).

```ts
export class ChangeDetector {
  constructor(vault: Vault, store: SnapshotStore, gi: GI, configDir: string);

  // Walk the vault, classify every syncable file, return the diff set.
  async findChanges(): Promise<FileChange[]>;

  // After a successful push, the runner calls this to tighten snapshots
  // for the files just pushed. mtime+size are re-stat'd internally so
  // the next findChanges() short-circuits cleanly.
  async recordSync(path: string, newRemoteSha: string): Promise<void>;

  // After a remote-driven delete, drop the snapshot row so the next
  // findChanges() doesn't resurrect "modified".
  recordDeletion(path: string): void;

}
```

Snapshot reconciliation against gitignore changes is folded into `findChanges()` directly — Pass 2 silently drops snapshot entries whose paths are now ignored. No separate `recheckAfterGitignoreChange` method.

### Algorithm of `findChanges()`

The first filter is `isSyncable`. Ignored files never reach `stat` or `readBinary` — that's the point. Snapshot store too is held to this rule: a stale entry for a now-ignored path is silently dropped in Pass 2 of the same `findChanges` call.

```
1. const out: FileChange[] = []
2. For every TFile from vault.getFiles() that isSyncable (gi.ignored + hardcoded
   blocklist via utils):
     stat = await vault.adapter.stat(path)
     snap = store.get(path)
     if !snap:
        // Brand-new file (never synced).
        out.push({ kind: "added", path, size: stat.size, mtime: stat.mtime })
        continue
     if stat.mtime === snap.mtime && stat.size === snap.size:
        // Stat-cache hit — content guaranteed unchanged.
        continue
     // Stat moved; re-hash to be sure it's not just a touch.
     content = await vault.adapter.readBinary(path)
     sha = await sha1Git(content)
     if sha === snap.remoteSha:
        // Touched but content matches remote — refresh stat so
        // subsequent calls short-circuit.
        store.set(path, { ...snap, mtime: stat.mtime, size: stat.size })
        continue
     out.push({
       kind: "modified", path, size: stat.size, mtime: stat.mtime,
       previousRemoteSha: snap.remoteSha,
     })

3. For every snap path NOT seen in step 2:
     out.push({
       kind: "deleted", path,
       previousRemoteSha: snap.remoteSha,
     })

4. return out
```

`isSyncable` for sync2 is reduced to two rules:
1. Hardcoded deny: `<configDir>/github-easy-sync-metadata.json`, `<configDir>/github-sync-metadata.json` (legacy artifact), `<configDir>/plugins/<self>/data.json`, anything inside `.git/`.
2. `!gi.ignored(path)` against the live GI.

No `syncConfigDir` toggle gate at this layer — that's a settings concern that lives in the GI feed (root vs configDir gitignores). Either we tell GI to load configDir gitignore or not, and ChangeDetector doesn't need to know.

### `recordSync` and `recordDeletion`

Called by Sync2Manager from inside `processQueue` after each successful per-file commit step. They keep SnapshotStore aligned with what's on the remote so the next push doesn't re-detect the same file as modified.

```ts
async recordSync(path: string, newRemoteSha: string): Promise<void> {
  const stat = await this.vault.adapter.stat(path);
  if (!stat) {
    this.store.remove(path);
    return;
  }
  this.store.set(path, {
    path,
    remoteSha: newRemoteSha,
    mtime: stat.mtime,
    size: stat.size,
  });
}

recordDeletion(path: string): void {
  this.store.remove(path);
}
```

## Tests

### `tests/sync2/snapshot-store.test.ts`

- Empty file path: load creates fresh state with null SHAs and empty `files`.
- Round-trip: set + save + new instance + load returns identical data.
- Legacy migration: hand-craft a file with old `dirty`/`justDownloaded`/`lastModified` fields; load drops them and converts `sha` → `remoteSha`.
- pendingQueueSyncs persistence.
- setLastSync overwrites prior commit/tree pair.

### `tests/sync2/change-detector.test.ts`

Backed by the existing `mock-obsidian.ts` Vault (fs-backed). Real files, real stats.

- New file in vault, no snapshot → `added`.
- Existing file, snapshot matches stat → not in result.
- Existing file, stat moved but content unchanged (touch) → not in result, snapshot mtime/size refreshed.
- Existing file, content changed → `modified` with `previousRemoteSha` from snapshot.
- Snapshot exists, file gone → `deleted`.
- isSyncable filtering: `<configDir>/github-easy-sync-metadata.json` skipped even if dirty.
- isSyncable filtering: a file ignored by `.gitignore` skipped — and `vault.adapter.stat` is **not** invoked for it (counter assertion).
- isSyncable filtering: a stale snapshot entry for a now-ignored path does not produce a `deleted` result (gitignore mute).
- recordSync after a push: subsequent findChanges short-circuits via stat-cache.
- recordDeletion: subsequent findChanges does not resurrect the path.
- gitignore-driven snapshot reconciliation (folded into `findChanges`):
  - file was syncable, gitignore now hides it → `findChanges` Pass 2 drops it from snapshot silently; nothing in `out` for that path.
  - file was ignored, gitignore now exposes it → `findChanges` Pass 1 emits `added`.
  - both directions in one rule edit (one rule added, one removed) — both effects appear in a single `findChanges` call.
  - no-op when gitignore unchanged.
- rename behaviour (no special hook — pure `findChanges` semantics):
  - syncable → syncable: snapshot stays at oldPath; result includes `deleted(oldPath)` and `added(newPath)`.
  - syncable → ignored: snapshot stays at oldPath; result includes `deleted(oldPath)` only; newPath is invisible.
  - ignored → syncable: no snapshot for oldPath; result includes `added(newPath)` only.
  - ignored → ignored: nothing.
  - cycle (syncable → ignored → syncable): after the second rename, snapshot still empty for the live path → `added(newPath)`.

Stat-cache hit path is the most important assertion; we want a counter to check `vault.adapter.readBinary` was NOT invoked when stat matches.

## Definition of done for Etap 2

- All tests above green; plus the existing 130-test unit suite still green.
- `pnpm build` passes.
- ChangeDetector and SnapshotStore are imported by no one yet — they live in `src/sync2/` and the rest of the plugin doesn't see them. Verification: `grep -r "snapshot-store\|change-detector" src/` returns only files inside `src/sync2/`.
- On a real Obsidian vault with `experimentalSync2` flipped on, instantiating Sync2Manager + ChangeDetector + SnapshotStore must not crash on load. (A small dev-only smoke test that just constructs the trio and calls `findChanges()` to log the result; we'll wire it into a hidden `Sync2: report changes` command for hand-checking before Etap 3 lands.)

## Risks for Etap 2

- **Stat behaviour on Obsidian mobile.** `vault.adapter.stat()` works; the field shapes (`mtime`, `size`, `ctime`) are stable. Confirmed by legacy code already using it.
- **mtime resolution differences across filesystems.** APFS gives sub-second; ext4/Android FUSE may quantise to seconds. The stat-cache compares for equality; quantisation alone doesn't break it because the same filesystem reports the same mtime twice in a row.
- **Brand-new files vs. justDownloaded races.** If sync2's `processQueue` writes a file (download), the very next `findChanges()` could see it as "added" if we don't update SnapshotStore inside the download step. Etap 3 (PushQueue) and Etap 6 (Sync2Manager) handle this by calling `recordSync` after each download — same hook as for uploads.

## Why not bigger steps

ChangeDetector is the smallest module that delivers a real-world performance win on its own (the 13s findDivergedPaths bottleneck disappears for unchanged files). It's also the one piece the next four modules consume, so getting its API right early avoids reshuffles later.
