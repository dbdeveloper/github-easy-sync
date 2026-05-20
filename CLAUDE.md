# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

1. Don't assume. Don't hide confusion. Surface tradeoffs.
2. Minimum code that solves the problem. Nothing speculative.
3. Touch only what you must. Clean up only your own mess.
4. Define success criteria. Loop until verified.
5. Follow Occam's Razor. Keep your project simple — but don't overcomplicate it. Not sure how? Just ask!

## What this plugin is

An Obsidian plugin that syncs a local vault with a GitHub repository using **only the GitHub REST API** — no `git` binary, no `isomorphic-git`. This constraint is deliberate so the plugin works identically on desktop and mobile. It means features like branching, merging, rebasing, or any non-GitHub host are out of scope.

The conflict-view UX is the one area still openly known to be primitive; everything else is intentional. All behaviour described below is locked in by the integration tests (`pnpm test:integration`). Test series A–L each correspond to a different concern — bootstrap, adoption, normalization, incremental, atomic conflicts, special chars, multi-device stress, out-of-band drift, settings lifecycle, auth/API failures, manifest corruption, accumulate semantics.

> **⚠️ Planned rework — Pseudo-merge mode (foundation).** The entire conflict-resolution layer is being rebuilt per [`PSEUDO-MERGE-MODE.md`](./PSEUDO-MERGE-MODE.md). High-level summary:
> - **User-visible removal:** ✅ Stage 1 landed — manual commit messages removed (2 of 4 Obsidian commands gone). Everything else stays as in 2.0.0-beta from the user's POV.
> - **Under the hood (in progress):**
>   - Conflict files live on a per-device GitHub branch (`easy-sync-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>` — millisecond suffix avoids cross-device name collisions on default `"Obsidian"` label) — not just local siblings.
>   - Resolution detection is **event-driven** via `vault.on('delete' | 'modify' | 'rename')` — explicit exception to the engine's polling rule (see "Polling model" below); conflict resolution is a separate subsystem from sync engine.
>   - `processBatch` does **split-push**: non-conflict files → main, conflict files → conflict-branch (variant β). Drain wraps batch processing in pause/sweep — ConflictWatcher paused mid-drain, drain-start + drain-end sweeps re-evaluate ConflictStore vs vault file system state.
>   - **Auto-merge attempt** preserved from 2.0.0-beta with one change: text → 3-way merge (`mergeText`); plugin-js → atomic semver; **binary → no auto-merge, always register as conflict** (`resolveBinaryConflict` removed — sibling pattern now works for any file type, avoiding silent atomic-mtime data loss).
>   - Three conflict **kinds** captured in ConflictStore record schema: `modify-vs-modify`, `delete-vs-modify`, `modify-vs-delete` (the last uses 0-byte `.deleted` suffix placeholder sibling).
>   - All resolution actions available through standard Obsidian file operations (delete sibling, rename over base, edit to SHA-identity, delete base) — no plugin UI required for the mechanism.
>   - ConflictStore is the **single source of truth**; `inConflictFiles` is derived from `ConflictStore.records` (not persisted separately). Records carry `siblingSha`/`baseSha` as **cached current** SHAs vs immutable `theirsBlobSha` (dedup identity).
>   - ConflictStore persistence follows **3-step atomic create protocol** (stage sibling content → atomic write meta.json → copy sibling to vault), with per-crash-window recovery sweep on onload. Concretizes existing principle #9 "Crash resilience" from `IMPLEMENTATION_PLAN.md`.
>   - The 2.0.0-beta conflict-resolution code (`applyRemoteAddOrModify`, `reconcileBatchAgainstHead` Case 4, `ConflictModal`, `onConflict` callback, `cascadeDeferRemoval`, `resolveBinaryConflict`) is **replaced from scratch**, not extended.
>
> **⚠️ Planned rework — Diff-Edit widget (`diff2` sub-project).** The conflict-view UI/UX is being reworked per [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). After pseudo-merge mode lands, **Diff2 becomes a pure UX layer** on top of it — diff side-by-side, multi-sibling navigation, bulk-resolve buttons. Nothing in Diff2 is critical for the resolution mechanism. `IMPLEMENTATION_PLAN.md` is partially outdated; **`PSEUDO-MERGE-MODE.md` has priority** wherever the two conflict.
>
> **Sequencing:** PSEUDO-MERGE-MODE.md is **stage 1** (a complete release on its own); IMPLEMENTATION_PLAN.md cleanup + Diff2 is **stage 2**.
>
> **The text below describes the currently-in-force behaviour until pseudo-merge mode lands.** When working on conflict resolution, read PSEUDO-MERGE-MODE.md first.

## Headline design intent

**The sync tries to behave like a primitive git client — but with predictable, easy-to-explain semantics, so users know what to expect.** The engine deliberately rejects features a power-user might want from a real git workflow (no branches, no rebase, no manual stash) and instead picks one safe default per scenario. Concretely:

- Two-side divergence on a file → 3-way merge if there's a base, atomic mtime tie-break otherwise. Same as `git pull --no-rebase` would do, minus the conflict marker dance for the safe cases.
- File missing on one side → pulled from / pushed to the other side. Same as `git pull` / `git push` adding new objects.
- File deleted somewhere → propagates, with modify-vs-delete resolved as "local-intent-wins" (delete wins if local, resurrection wins if local-modified). Matches git-default conservativeness ("keep the change-side").
- "Adoption" (first sync against a non-bare repo with local content) is **non-destructive**: local files are NEVER overwritten without an mtime check that says remote is newer.

**Two places where the engine intentionally diverges from "primitive git":**
- **`<configDir>/plugins/<id>/main.js` and `manifest.json`** — atomic semver resolution (read `manifest.json` from both sides, higher version wins, mtime tie-break). A 3-way merge on a minified plugin bundle produces garbage that crashes Obsidian on load, so we don't do it.
- **Binary files** — atomic mtime resolution always; no merge attempt. PNG / mp4 etc. have no useful "merge".

Everything else inherits git-shape behaviour. The detail of how each path is resolved lives below in "Architecture" → "Conflict resolution".

## Commands

Package manager is **pnpm** (CI uses `pnpm@latest-10`).

- `pnpm dev` — esbuild watch mode, emits `main.js` with inline sourcemaps. Set `OBSIDIAN_PLUGIN_DIR` env var to also mirror `main.js` / `manifest.json` / `styles.css` into a vault's plugin folder on every successful build (paths starting with `~/` are expanded). On macOS, IDE-set env vars don't pass through shell expansion — the config does that itself.
- `pnpm build` — typecheck (`tsc -noEmit`) then production bundle. Run before committing; CI runs the same on tag pushes.
- `pnpm test` — vitest, runs once and exits. 429 unit tests across 18 spec files covering pure helpers, snapshot/queue invariants, classifiers, and the orchestrator under a fake client. Mocks the `obsidian` module via `vitest.config.ts` alias to `mock-obsidian.ts`. ~4 s wall-clock.
- `pnpm test:watch` — vitest watch mode.
- `pnpm test:integration` — full integration suite (~106 tests, ~19 min end-to-end). Real GitHub round-trips via the fine-grained PAT against the private int-test repo. Includes bootstrap (A1/A2 + 10-iter stress). See "Testing" below for env vars and layout.
- `pnpm test:integration:bootstrap` — bootstrap suite only (uses the public ephemeral repo, classic PAT). Slow because each test deletes + recreates the repo.
- `pnpm test:integration:nonbootstrap` — everything except bootstrap. Cheaper because branch-per-test on the persistent int-test repo.
- `pnpm test:perf` — opt-in performance baselines under `tests/perf/`. Not part of CI; emits structured `PERF_BASELINE {…}` lines on stdout. See "Testing" below.
- `pnpm benchmark` — `benchmark.ts`: real `firstSync` against GitHub. Requires env vars `GITHUB_TOKEN`, `REPO_OWNER`, `REPO_NAME`, `REPO_BRANCH` and an SSH-accessible remote (uses `git clone` over SSH to wipe the repo between runs). Predates the integration suite; the test:integration script is usually preferred now.

Releases are triggered by pushing a tag matching `[0-9].[0-9]+.[0-9]+*` (a `-beta` suffix cuts a prerelease); `version-bump.mjs` syncs `manifest.json` and `versions.json` from `package.json`.

## Architecture

### Entry points

`Sync2Manager` is the only orchestrator. Public methods, all idempotent; `drain` is guarded by a `running` flag so concurrent calls don't double-process:

- `syncAll()` — whole-vault sync. Click body is LOCAL-ONLY after bootstrap: `reconcileRemoteIdentity` → `bootstrapIfNeeded` (one-time when `lastSyncCommitSha === null`, O(1) skip thereafter) → `invariants.enforce` → `findChanges` → `enqueueOrMerge` → `drain()`. The drain pulls + pushes; the click returns when the batch is on disk so the user can keep editing while network catches up.
- `syncFile(path)` — single-file sync, same shape as `syncAll`.
- `resumeQueue()` — thin wrapper around `drain()`. Called from `main.ts` onload to drain any pending batches left over from a previous Obsidian session, and from the interval/watchdog timer's `backgroundDrain()` wrapper (which adds `suppressConflictModals` so a pull-side conflict auto-defers instead of blocking on a modal). `drain()` already pulls at the start of each iteration, so a separate "pull-only" entry point isn't needed — drain with an empty queue is effectively pullOnly.
- `hasPendingBatches()` — gate the watchdog uses to decide "interval OFF + queue empty → no-op".

Wired in `main.ts` to two Obsidian commands: `Sync with GitHub` and `Sync current file with GitHub`.

### Drain runner (`drain()`)

`drain()` is the network worker. One pass per pending batch:

```
await bootstrapIfNeeded(progress?)     ← O(1) skip when lastSync already set;
                                         otherwise routes through adoption or
                                         bare-repo seed before any pull happens.
while (true) {
  await pullIfNeeded(progress?)        ← apply remote changes since lastSync
  ids = await queue.list()
  if (ids.length === 0) break          ← queue empty, done
  // Lazy-open the long-lived progress notice iff this batch's push is
  // heavy (estimateBatchBytes > PROGRESS_BYTES_THRESHOLD, default 500 KB).
  await processBatch(ids[0], headHint, progress?, …)
}
// Finale: if progress was opened, transition same handle to "Sync done"
// + auto-hide 1 s. If not opened but drain did real work (pulled >0
// files OR pushed >0 batches), open a brand-new brief 1-s "Sync done".
// Genuine no-op drains stay silent.
```

The `running` boolean prevents re-entry; new batches enqueued mid-drain land on disk and the active drain picks them up on its next `queue.list()` iteration. A failed batch (`.attempted` marker survives) is retried on the next trigger (next click / interval tick / onload).

Pull and push are interleaved per batch so each push lands on the freshest possible HEAD: even if a prior batch in the same drain advanced HEAD itself, the next iteration's pull re-syncs against that before computing the next batch's tree.

`bootstrapIfNeeded` at the top of drain is non-negotiable: background entry points (onload's `resumeQueue`, interval-tick `backgroundDrain`) reach drain directly without going through the click body, so without this they'd silently no-op on a fresh device (pullIfNeeded returns null when `lastSyncCommitSha === null`). Pinned by two unit-tests in the `drain — bootstrap entry point` describe block.

### Polling model (NOT event-driven)

The engine does **not** register Obsidian vault events. `findChanges` (`change-detector.ts:100`) walks the whole vault on each sync call. A watermark (`SnapshotStore.lastCommitMtime`) skips unchanged files via `file.stat.mtime <= watermark` — one stat per file, content read only for the narrow candidate set.

Implication: vault edits made while the plugin was disabled get picked up on the next sync click without any "missed events" failure mode (covered by E1 test).

> **Planned exception (PSEUDO-MERGE-MODE.md).** The new conflict-resolution layer is a separate subsystem and IS event-driven (`vault.on('delete' | 'modify' | 'rename')`). The polling rule above is preserved for **sync engine**; conflict resolution becomes its own real-time layer because the UX requires immediate state updates when the user deletes/renames/edits conflict-files. Sync engine still doesn't subscribe to events.

### PushQueue: persisted commit intent

Located at `<configDir>/plugins/github-easy-sync/.push-queue/`. Each pending sync is a directory:

```
.push-queue/
  20260514093823777/
    .in-progress       ← runner is actively pushing this batch
    .attempted         ← processBatch has touched this batch ≥ 1 time
    .meta.json         ← see "Meta fields" below
    deleted-paths.txt  ← optional; one path per line
    vault/             ← byte-for-byte snapshot of user's intent at enqueue
      Folder/note.md
      attachments/img.png
```

**Meta fields** (`.meta.json`):
- `commitMessage` — final commit text. Refreshed on accumulate-merge via `updateCommitMessage`.
- `parentCommitSha` / `parentTreeSha` — where we'll build the commit. Updated by reconcile, by the stale-parent guard, or by `seedBareRepo`.
- `createdAt` — local clock at enqueue.
- `uploadedBlobs: Record<path, sha>` — paths whose `createBlob` succeeded in a prior attempt. TreeBuilder consults this map before re-uploading.
- `fileMtimes: Record<path, mtime>` — per-file mtime captured at enqueue BEFORE `copyFileFromVault`'s canonical-text writeback can bump live mtime. Reconcile's binary/plugin-js atomic resolution uses this — otherwise the canonicalize-write-back path would silently flip every mtime tie toward "local wins" and break E3/E4-shaped scenarios.

**Marker semantics:**
- `.in-progress` set at start of `processBatch`, cleared on success (via `delete(id)`) OR failure (via `clearInProgress`).
- `.attempted` set at start of `processBatch` and **never cleared on failure** — only removed when the batch dir is deleted on commit success. Models the rule: "failed batch is frozen against new merges; the next sync click creates a new batch".
- `mergeIntoLatestPending` skips batches that are `in-progress` OR `attempted`.

### Adoption (first sync against a non-bare remote)

`bootstrapFromRemote` (the entry point for adoption) is **non-destructive**. Per-file decision:

- Local missing → pull, write vault, recordSync.
- Local exists, SHA matches remote → recordSync only (no transfer, no overwrite, mtime preserved).
- Local exists, SHA differs **AND canonicalize is ON AND file is text** → canonicalize-aware resume probe: fetch the remote blob, run it through the same `normalizeText` we'd apply on write, recompute its git-blob SHA, and compare to local. **Match → recordSync against the canonical SHA, treat as identical** (this is our own previous interrupted-adoption write, not a user edit). No match → fall through to the atomic mtime branch below.
- Local exists, SHA differs → atomic mtime resolution:
  - `local.mtime >= remoteHeadCommit.committerDate` → **keep local**. No recordSync; findChanges later emits "added" and the next push lifts local to remote.
  - Else → pull, **overwrite local in place**, recordSync.

Local-only files (in vault, not in remote tree) are untouched here; findChanges picks them up post-adoption as "added".

Tie on mtime → local wins. No "deleted-on-this-device" detection (no history); README must instruct users to pre-sync via their previous tool. Covered by **B1–B7** tests under `tests/integration/scenarios/sync2/adoption/`.

**Why the canonicalize-aware probe exists.** Without it, the sequence "fresh client + canonicalize ON + Android suspends Obsidian mid-adoption + user re-foregrounds and clicks Sync" produced a surprise N-file convergence push on first setup. Step-by-step: first attempt pulled M files and wrote them out as canonical bytes (LF / no-BOM / trailing-NL), but `recordSync` was intentionally skipped (canonicalization changed bytes → snapshot stays stale by design — see "Text canonicalization toggle" below). Process died before `setLastSync` at the end of `bootstrapFromRemote`, so on disk we had M canonical files but no snapshot entries and `lastSyncCommitSha === null`. Second attempt re-entered `bootstrapFromRemote`, saw the local files, computed their **canonical** git-blob SHA, compared to remote tree's **raw** git-blob SHA (with original CRLF/BOM), found them different, fell into the mtime branch, decided local won (mtime is "just now"), and skipped recordSync again. `findChanges` then emitted all M files as "added", pushing canonical bytes back to GitHub as if user-edited. The probe closes this gap: one extra `getBlob` per non-identical text file during adoption only — post-adoption fast path (`pullIfNeeded`) never reaches this code. Pinned by **B7**.

### Bare-repo bootstrap

When the remote branch has zero commits (`bootstrapIfNeeded` saw 404/409 on `getBranchHeadSha`; `processBatch` arrives at Case 1 with `expectedHead === null && currentHead === null`):

1. `seedBareRepo(id)` writes `<vault>/.gitignore` (guaranteed by `invariants.enforce()`) via Contents API — the only endpoint that works without a pre-existing ref. Commit message: `"Init at {date} {time} ({deviceLabel})"`.
2. Returned `{commitSha, treeSha}` become the batch's parent. Rest of `processBatch` proceeds normally (`createTree` → `createCommit` → `updateBranchHead`).
3. **No-op-tree-skip**: if `newTreeSha === parentTreeSha` (e.g., batch only carried the file the seed already wrote), the secondary commit is skipped; lastSync points at the seed.

Covered by `tests/integration/scenarios/sync2/bootstrap/sync2-bare-repo.test.ts` (5 named cases + 10-iter `it.each` stress loop guarding the eventual-consistency 409 flake).

### Retry policy

- `isRetriableStatus(status)` (`src/utils.ts`): 422 / 429 / 5xx. Used by **READ** methods (`getRepoContent`, `getBranchHeadSha`, `getCommit`, `getContentsAtRef`, `compare`, `getBlob`). 409 here is the documented "Git Repository is empty" bare-repo signal — must return immediately, not retry.
- `isWriteRetriableStatus(status)`: adds **409** to the above. Used by **WRITE** methods (`createTree`, `createCommit`, `createBlob`, `updateBranchHead`, `createFile`, `createReference`). 409 here is GitHub's "ref/index not yet propagated across replicas" — empirically a ~20% flake on back-to-back syncs, reliably cleared by the first exponential-backoff retry.

If you extend retry for a specific method, prefer using/extending `isWriteRetriableStatus` over inline 409 handling — keeps the "reads stay immediate" invariant intact.

### Resume strategies (four layers)

1. **Pull-side resume (adoption)** (`bootstrapFromRemote`): per-file loop skips `getBlob` when the local file already has the SHA the tree announces. A bootstrap that crashed after 6 of 50 files re-runs and only fetches 7–50. Extended with the canonicalize-aware probe (see "Adoption" above) for the canonicalize-ON-mid-interrupt case.

2. **Pull-side resume (incremental)** (`pullIfNeeded`): mirrors layer 1 for normal pulls. Before each `getBlob` round-trip, hashes the live file and compares to `f.sha` from `compare`; on match, skips the fetch + apply path and just stat-caches the snapshot. Drain that crashed after 45 of 50 file applies re-runs and only does the remaining 5.

3. **Push-side resume** (`tree-builder.ts` + `PushQueue.uploadedBlobs`): after each `createBlob` success, TreeBuilder calls `queue.recordBlobUpload(id, path, sha)`. On retry of the same batch, paths in `uploadedBlobs` skip the `createBlob` call and use the cached SHA inline. Serialized through `metaWriteQueue` so `Promise.allSettled` callbacks don't clobber each other.

4. **findChanges-vs-queue bridge** (`change-detector.ts:findChanges`): before emitting "added"/"modified", consults `queue.peekPathSha(path)`. If a pending batch already holds this path with the local-computed SHA, **skip emit**. This stops "second sync after a crash" from creating a duplicate batch — regardless of the `accumulateOfflineSyncs` setting.

### Conflict resolution

> **⚠️ This entire section describes 2.0.0-beta behaviour that PSEUDO-MERGE-MODE.md replaces from scratch.** The new model uses a per-device GitHub conflict-branch, event-driven detection, split-push at processBatch, and 3-case resolution (cases 1/3/4). `applyRemoteAddOrModify`, `reconcileBatchAgainstHead` Case 4, `ConflictModal`, and `cascadeDeferRemoval` are all being removed. See PSEUDO-MERGE-MODE.md for the new design. Text below is **current-shipping** behaviour, accurate until pseudo-merge lands.

Conflict resolution fires from two contexts that share the same per-type dispatch logic:

**Pull-side: `applyRemoteAddOrModify`** — for paths that changed remotely but are NOT in any pending batch. Reads "ours" from the live vault; writes resolution to the live vault.

**Push-side: `reconcileBatchAgainstHead`** — for paths in `batch.files` where remote moved (Case 4 in `processBatch`). Reads "ours" from the batch's snapshot in `.push-queue/<id>/vault/`; writes resolution to that snapshot + mirrors to the live vault.

Dispatch by path shape (used by BOTH contexts):

| Path shape | Path examples | Resolution |
|---|---|---|
| Non-text | `*.png`, `*.pdf`, etc. | `resolveBinaryConflict` — atomic mtime, tie → local. Reconcile uses `batch.fileMtimes[path]` for the local-side mtime (capture-pre-canonicalize). |
| Plugin file | `<configDir>/plugins/<id>/main.js` OR `…/manifest.json` (any depth) | `resolvePluginJsConflict` — semver from the plugin's `manifest.json`, fallback to mtime on tie/parse-fail. Reconcile reads local manifest from the BATCH snapshot when the batch carries `manifest.json`, else from baseRef (lastSync) — never from the live vault, which pull may have just overwritten. |
| Other text | everything else with `hasTextExtension(path)` | 3-way merge against `expectedHead`; conflict → `onConflict` callback. Deferred decisions create sibling files via ConflictStore. |
| Local-deleted vs remote-modified | path in `batch.deletions` + remote modified the same path | Fires conflict resolution. `ours = ""` (the deletion), `theirs = remote bytes`. User picks: resolved with empty content → keep delete; resolved with content → restore file with that content (deletion dropped, batch gains a file entry to push); deferred → sibling file + ConflictStore + cascade. Binary delete-vs-modify keeps the silent delete-wins for now (no useful UI for 3-way against empty ours on binary). |

`isAtomicPluginFile(path, configDir)` (in `src/sync2/plugin-js.ts`) is the gate for the plugin-file branch. **Only `.js` AND `manifest.json` under a plugin folder match**; `styles.css`, README files, etc. go through standard text 3-way merge.

**Pull defers to push-side reconcile for queue-overlap paths**: `pullIfNeeded` skips `applyRemoteAddOrModify` for any path mentioned in a pending batch (`queue.collectAllPaths()` — covers both `batch.files` and `batch.deletions`) and **withholds the `lastSync` advancement** so `processBatch`'s Case 4 (`reconcileBatchAgainstHead`) runs the resolution against the **batch's snapshot** instead of the live vault. Pinned by C3.

**ConflictStore dedup at create()**: identical `(vaultPath, theirsBlobSha)` is deduplicated — if a record already holds this exact remote version for this path, `create()` returns it instead of spawning a duplicate. Guards against drain loops that re-encounter the same compare result mid-cycle (pull's queuedPaths-defer in iter 1 + reconcile defer + iter 2 pull re-firing on the same unchanged remote head). Different `theirsBlobSha` still spawns new records — multi-copy semantics intact.

**`cascadeDeferRemoval`**: a path the user just deferred in reconcile also drops out of every subsequent queued batch (from the current one onwards). The current batch's removal is left to processBatch's empty-batch-skip (so reconcile's post-resolve `updateMeta` can still run against an intact dir); later batches are deleted immediately if they become empty after the cascade.

**ConflictStore orphan cleanup at load()**: on every `load()`, for each indexed record, the store verifies the sibling file still exists. Missing sibling → treat the conflict as implicitly resolved (rmdir the `.conflicts/<id>/` folder, skip indexing). Handles "user deleted the sibling via vim/cli while Obsidian was closed" without leaving the record forever stuck filtering the path out of every push.

### Diff-Edit widget (planned)

**Status: planned, not yet implemented.** Full design in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). Brief summary of the upcoming reshape (each bullet maps to one of the plan's R-sections — refer to the plan for the full contract before touching related code):

- **No more per-file `ConflictModal`** during sync. New conflicts are created silently as siblings; a single summary modal at the end of sync says "N pending conflicts. `[Open in Diff-Edit]`" (R1).
- **Single-pane unified Diff-Edit view** (view type `diff2-edit-view`, new sub-module `src/diff2/` named by analogy with `src/sync2/`) replacing the two-pane `ConflictView` (view type `sync2-conflict-view`). Mobile-first; mode switching list ↔ detail via `[←]` back-arrow. Side-by-side `MergeView` branch removed; only unified remains (R2.0, R7.1).
- **Four functional modes** in the same widget: Conflicts list, Compare any two files, File history (GitHub + push-queue fallback), Recently deleted. **Asymmetric entry-points**: Conflicts/Deleted are global lists exposed as sub-tabs in the view header (via ribbon button, status bar icon `🔀 N · 🗑 M`, and the post-sync summary modal); Compare/History are file-bound detail sessions opened via right-click "Compare with…"/"Show history" on a file in the Obsidian file-explorer or via command palette. Each mode has its own top toolbar (R2, R2.7, R7.9a–d).
- **List-size settings** (no `[Load more]` UX) for the two GitHub-history-backed lists: `recentlyDeletedListSize` (default 30) and `fileHistoryListSize` (default 10). Eager-fetched on open via `per_page = min(N, 100)` + extra pages if `N > 100`. Users who need more open Settings and change the number.
- **Reactive auto-resolve** of conflicts when (T1) sibling deleted (already works), (T2) `gitBlobSha(ours) === gitBlobSha(sibling)` and sizes match, (T3) main file deleted → bundle main + all sibling/conflict records to `.trash/<id>/` atomically; restore brings them all back (R4). `gitBlobSha(ours)` is cached by `(path, mtime, size)` for the drain-start sweep, mirroring the `SnapshotStore.lastCommitMtime` watermark pattern (R4.4).
- **Local `.trash/<id>/`** for recently-deleted files. Move (not copy), pull-deletes skip trash, TTL=0 after sync confirms deletion. Unified "Recently deleted" UX merging trash + GitHub-history-recovery (R3).
- **Transactional renames** for files with pending conflicts (R3.3): N sibling renames + N meta.json updates + reindex run through a 3-phase manifest in `.tmp/rename-<txId>/` so a kill mid-rename is recoverable on next `onload`.
- **Sync refuses on files with pending conflicts.** `Sync this file` shows a Notice with `[Open in Diff-Edit]`; `Sync all` silently skips them and reports `K files skipped` in the summary modal (R2.6). The exact exclusion layer (`findChanges` vs `processBatch`) is still **R2.6-RESEARCH-NEEDED** — see plan for the four candidate options and the C3-interaction concern.
- **Persistent autosave** of in-flight conflict resolutions (R7.7): throttled 1.5s writes to `.diff2-autosave/<conflictId>/{buffer.txt, history.json, cursor.json, meta.json}` with atomic-rename, CM6 history serialized for full undo-stack persistence. Two exit paths: `[←]` back commits buffer → vault + drops autosave; `[x]` tab close drops autosave without writing vault. Reopening an interrupted session shows a `[Continue editing] / [Start over]` recovery dialog. Vault-file-changed-between-sessions edge case has its own dialog with `[Start over]` defaulted.
- **Optional desktop-only external diff tool** (`gvimdiff`, `meld`, `windiff`, `code --diff`, etc.) via a configurable command template launched through secure `spawn` without shell. Mobile completely opted out via `Platform.isDesktopApp` guard (R6).
- **No default hotkeys.** All actions exposed as Obsidian commands (command palette auto-prefixes with `github-easy-sync:`); users bind their own via the Hotkeys settings page (macOS `Alt-N` is `ñ`, mobile has no keyboard) (R7.9).

**Implementation discipline** (`IMPLEMENTATION_PLAN.md` → "Принципи реалізації", 9 rules):
- **#8 NO LEGACY** — when new component lands, old is deleted in same PR. No `sync2-conflict-view` alias-redirect, no feature-flag fallback, no parallel `if (newDiffPane) { … } else { … }`. Stale code lives only in git history.
- **#9 Crash resilience** — every multi-step disk op has a documented recovery sweep (plan §R8 table) that runs in `onload` and a kill-mid-op test. Inv: after recovery sweep, state on disk is either fully completed or fully rolled back — never half-applied.

When working on conflict resolution, read `IMPLEMENTATION_PLAN.md` → "Принципи реалізації" first. Each phase brings its own CLAUDE.md edits that *replace* the relevant parts of the "Conflict resolution" section above with the new behaviour — until that happens, the existing text remains authoritative for currently-shipping code.

### Lazy progress notice + Sync done finale (UX contract)

Notice handling is split across two independent handles so the click feels instant on idle vaults and detailed on heavy syncs:

**Click-time brief flashes** (independent `Notice`, ~700 ms auto-hide):
- Local commit succeeded with N changes → "Commit N files" (or "Commit 1 file")
- findChanges empty AND queue empty → "Nothing to commit"

Wired via `onLocalCommitted(count)` / `onNoLocalChanges()` callbacks. main.ts shows the toast; tests pass spies.

**Drain-level long-lived handle** (`onProgress`), opened LAZILY:
- Pull is "heavy" iff total tree size of syncable changes > `PROGRESS_BYTES_THRESHOLD` (default 500 KB; tunable via `Sync2ManagerDeps.progressBytesThreshold` — tests pass 0 to force-open).
- Push is "heavy" iff `estimateBatchBytes(id) > PROGRESS_BYTES_THRESHOLD`.
- Single-file heavy phase: "Pull file from GitHub…" / "Push to GitHub…". Multi-file heavy: "Pull N/M files from GitHub" / `Push X/N…` with the tree-builder hooks ticking the counter.
- Drain finale: queue empty → if the long-lived handle was opened anywhere during the run, update its text to **"Sync done"** (or "Sync done (N files updated from GitHub)" when `pulledFilesThisSync > 0`) and `setTimeout(hide, 1000)`. Single handle, smooth transition, no flicker. When the handle was never opened but drain did real work (pulled OR pushed), a brand-new 1-s "Sync done" briefly flashes. True no-op drains stay silent — `onNoLocalChanges` already covered the click.

`pulledFilesThisSync` is the user-visible "vault was changed by sync" counter. Bumps at every local-mutation site inside the drain: pull's applyRemoteDeletion + applyRemoteAddOrModify, every ConflictStore.create (sibling file landed in the vault).

`onSyncCompleted({pushedFiles, pulledFiles})` is an observability hook only — kept on the deps surface for tests + future wiring but main.ts treats it as a no-op since the drain itself owns the visible "Sync done".

### IntervalScheduler

`src/sync2/interval-scheduler.ts` owns the periodic timer + startup orchestration. Lives outside `main.ts` so all three decision branches are unit-testable (`tests/sync2/interval-scheduler.test.ts`, 21 cases with an injected fake-timer).

Three modes:

1. **Interval enabled + autoCommitOnSync ON** — every tick + startup runs the full sync (commit + pull + push) like a manual Sync click.
2. **Interval enabled + autoCommitOnSync OFF** — every tick + startup runs `drain()`. drain pulls + pushes any pending batches in one cycle; with an empty queue it's effectively pull-only. The user's own edits stay uncommitted (no findChanges/enqueue inside drain).
3. **Interval disabled (watchdog)** — tick fires `drain` ONLY when the on-disk queue has pending batches (retries pushes that failed earlier). Empty queue + interval disabled → no-op, no GitHub poll. Startup behaviour is the same as mode 2: "Sync on startup" overrides the disabled strategy for the one-shot startup pulse.

Cadence: user's `syncInterval` minutes when enabled (clamped to ≥ 1); hardcoded 5 min when disabled (watchdog default). `Sync interval` default is **5 min** — the typical job is "retry stuck drains in the background", not aggressive polling.

`IntervalScheduler.getTimerId()` exposes the live `Window.setInterval` handle so `main.ts` can pass it to Obsidian's `registerInterval()` for the plugin-unload cleanup hook.

### Text canonicalization toggle (`autoCanonicalizeTextFiles`)

Default **`false`** (opt-in). Text files (per `hasTextExtension`) get rewritten locally to LF / no-BOM / trailing-NL on both pull (after fetching from GitHub) and on enqueue (before snapshotting into the batch). The toggle gates:

1. `Sync2Manager.writeRemoteText` — pull-side normalization. When off, raw bytes are written verbatim, `canonicalSha === blob.sha`, `changed = false`, so the snapshot lands a recordSync on first pass.
2. `PushQueue.copyFileFromVault` — enqueue-time normalization of the user's edits. When off, the live vault file is NOT rewritten and bytes go to the batch verbatim.
3. `PushQueue.overwriteFile` — reconcile-resolved writeback. When off, resolved bytes land in the batch dir verbatim.

When canonicalization is on AND a write changed bytes, `recordSync` is INTENTIONALLY SKIPPED. The next `findChanges` sees the local-vs-snapshot divergence and emits the file as modified; the next push uploads the canonical bytes back. Convergence happens on the next click (a documented one-click delay) but the engine has one fewer special path.

**Why the default is `false`.** With `true`, a first adoption against a repo with CRLF / BOM / missing-trailing-NL history (very common: Windows users, repos previously synced via obsidian-git, anything pulled from a Windows-authored upstream) produces an unexpected "convergence push" on the very first click — every non-canonical text file gets pulled, rewritten locally, then pushed back as if user-edited. The canonicalize-aware probe in `bootstrapFromRemote` (see "Adoption" above) makes the interrupted-mid-adoption case safe, but the convergence push on `true` is still a UX surprise on first setup. `false` gives byte-exact passthrough out of the box; users who genuinely want canonical text on disk turn it on explicitly via the settings tab.

Toggle threaded via live getters into both `PushQueue` and `Sync2Manager` so flipping it in the settings tab takes effect on the very next sync.

### Accumulate semantics

- With `accumulateOfflineSyncs: true`: `mergeIntoLatestPending` finds the youngest pending+non-in-progress+non-attempted batch and folds new changes into it. After the merge, `enqueueOrMerge` calls `updateCommitMessage` so the batch's commit message reflects the **latest** click's template render — not the first.
- A failed batch is `attempted=true` → next click creates a fresh batch (not folded). Practical "accumulate" window: clicks that arrive WHILE a previous slow push is in-progress accumulate into a NEW second batch that the runner will pick up after the in-progress one finishes.
- Covered by **L1, L4** in `tests/integration/scenarios/sync2/accumulate/`.

### "Push plugins data.json to GitHub" toggle

Settings-tab checkbox, **OFF by default**. Plugin `data.json` files routinely store secrets — API tokens, account credentials, license keys — that the user rarely intends to publish, and any GitHub repo can transition from private to public by accident. Safe-by-default makes the safe choice the easy choice.

**State lives inside our invariant block**, not in `data.json`, not in user-editable gitignore territory. The block ALWAYS contains a `data.json` rule — the toggle just flips the leading `!`:

```
# ===== github-easy-sync invariants — DO NOT EDIT =====
# Editing this block triggers a rewrite to canonical on next load.

# Per-device state — never propagate between machines.
github-easy-sync-metadata.json
workspace.json
workspace-mobile.json
community-plugins.json
plugins/*/data.json          ← OFF (block rule, no !)
# !plugins/*/data.json       ← ON  (allow rule, with !)
# ===== end of invariants =====
```

The line is stand-alone — it does NOT depend on `plugins/*/*` existing elsewhere in the file. The recommended-defaults section is only seeded when WE create the gitignore from scratch; if the user already had an `.obsidian/.gitignore` before installing the plugin, only our invariant block goes in at the top and nothing else is added below. So OFF state has to carry an explicit block rule, not rely on a sibling catch-all.

The gitignore IS synced across devices, so this toggle is implicitly **shared cross-device**: whichever device last pushed the gitignore wins, and on the next sync every other device's checkbox flips to match. No separate per-device field, no ping-pong, no drift.

Implementation:
- `configDirInvariantBlock({ pushPluginsDataJson })` is the single function that builds the canonical block — both for `enforce()` and for the toggle. The block is ALWAYS rewritten in place via `spliceInvariantBlock`; it can't multiply, drift, or end up in user territory.
- `GitignoreInvariants.getPushPluginsDataJson()` reads the file, extracts the body between BEGIN/END markers via `extractInvariantBlock`, and tests for the `!`-prefixed line via `blockHasAllowLine`. Returns `false` (OFF) on missing file or malformed block.
- `GitignoreInvariants.setPushPluginsDataJson(enabled)` builds the canonical block with the requested state, splices it into the file. Idempotent — if the spliced result equals the existing content, no write happens.
- `enforce()` preserves the toggle state on every rewrite: it reads the current state from the existing block first, then writes the canonical version with that same state. Without this, a routine enforce() would clobber the user's toggle.

Settings-tab UI peculiarity: `toggle.setValue(v)` called from an **async** context (a `.then()` callback) triggers an infinite re-entry inside Obsidian's settings pipeline that freezes the renderer at 100% CPU. The cause is in Obsidian internals, not our code (verified by replacing the I/O with a static `Promise.resolve(true).then(toggle.setValue)` — still froze). Workaround: read the toggle state ONCE at `onload` and cache on `plugin.pushPluginsDataJsonCached`; the settings tab uses the cached value **synchronously** in `display()`. The cache stays fresh because every successful `setPushPluginsDataJson` call from `onChange` also updates the cache. The drawback — if a peer device pushes a toggled gitignore between sessions, our cache is stale until the next `onload` — is acceptable; the user re-opens settings to see the propagated state.

**OUR plugin's own `data.json` is ALWAYS blocked**, regardless of this toggle, by two redundant layers:
1. The self-plugin gitignore at `<configDir>/plugins/github-easy-sync/.gitignore` (auto-rewritten on every plugin load to `* / !main.js / !manifest.json / !styles.css / !.gitignore`) — `data.json` matches `*` with no allow exception.
2. A hardcoded denylist in `isSyncable` (`change-detector.ts:29`) — defense in depth in case the self-plugin gitignore is tampered with. Our `data.json` carries the GitHub token; no toggle should ever expose it.

### "Sync configs" toggle (`syncConfigDir`)

Per-device gate for paths under `<configDir>/`. Lives in `data.json` (per-device by design — that file is hard-blocked from sync, so the setting can't propagate). **Default `false`** (explicit opt-in). Obsidian configs include workspace state, theme settings, and plugin install state; many users (especially multi-device users) don't want one machine's layout overwriting another's, so the safe default is OFF and the user opts in via the settings tab.

When OFF, `isSyncable` returns `false` for every path under `<configDir>/` — fully symmetric, both push and pull. The two invariant gitignore files (`<configDir>/.gitignore` and `<configDir>/plugins/<self>/.gitignore`) are NOT exempt: each device keeps its own canonical via `GitignoreInvariants.enforce()` on plugin load, so cross-device propagation of those files isn't needed.

Threaded through as a live getter — `() => settings.syncConfigDir` — so flipping the toggle in the settings tab takes effect on the very next `syncAll` without rebuilding the manager. The detector consults it via `checkSyncable(path)` for both push (`findChanges`) and pull (`applyRemoteAddOrModify`).

**Enumeration**: production Obsidian's `vault.getFiles()` does NOT index files under `<configDir>/` (legacy bug confirmed against a real vault: `getFiles()` returned `Welcome.md` but skipped `.obsidian/.gitignore`). When the toggle is ON, `findChanges` additionally walks `<configDir>/` via `adapter.list()` recursively to surface those paths. When OFF, the walk is skipped entirely — no extra syscalls.

**OFF → ON is forward-looking.** When OFF, a remote change to a configDir path is filtered by the gate but `lastSync` still advances to current `HEAD` (the gate filters the file, not the commit). Toggling ON later does NOT retroactively pull configDir paths that drifted on remote during the OFF window — `compare(lastSync, HEAD)` returns empty. The next remote change to those paths after toggle ON does pull as normal. Matches a `git update-index --skip-worktree` analogue: unskipping doesn't retroactively pull, only forward changes do. Covered by I3.

### Remote identity tracking

The snapshot store records the `(owner, repo, branch)` triplet it was last reconciled against. `Sync2Manager.reconcileRemoteIdentity()` runs at the very start of every `syncAll`/`syncFile` — BEFORE `bootstrapIfNeeded` and `pullIfNeeded` — and compares the recorded triplet to current settings:

- **First observation** (`remoteIdentity == null`): record current settings, don't reset. Existing `lastSync` state stays intact.
- **Matching triplet**: no-op.
- **Mismatch** (user edited owner/repo/branch in the settings tab): wipe `SnapshotStore` + `PushQueue` + `ConflictStore`, record new identity. The rest of `syncAll` then routes through `bootstrapFromRemote` (adoption) against the new remote because `lastSyncCommitSha` is null.

All three components — owner, repo, branch — are treated equally. A bare branch change triggers the same wipe as a full repo change: the previous `lastSync` commit isn't on the new branch and `compare` would 404 or return wrong diff. This intentionally trades "branch switching costs a full re-adopt" against "branch switching never silently leaks content from one branch to another". Covered by I6 + unit tests in `tests/sync2/sync2-manager.test.ts` under `reconcileRemoteIdentity`.

Why wipe push-queue too: pending batches on disk reference the *previous* repo's parent SHAs. If we kept them across a repo switch, the next push would either fail (wrong parent on the new repo) or silently push wrong content. Wiping the queue is the only safe option.

### "Reset" settings button

Panic-button in the settings tab under "Danger zone". Two-step confirmation modal (user types `RESET` to enable the confirm button). On confirm: wipes `settings` to `DEFAULT_SETTINGS` (clears GitHub token, owner, repo, branch, etc.) + `SnapshotStore.clear()` + `PushQueue.clearAll()` + `ConflictStore.clearAll()`. Local vault files are NOT touched.

Use cases the design supports:
- Token rotation after a suspected leak — kills the in-flight push before the new owner of the token can intercept it.
- Manual fresh-clone setup before reconfiguring against a different repo (the auto-detect handles the common case; Reset is for "I want to nuke everything").
- Troubleshooting "something feels wrong" without uninstalling.

Implemented in `main.ts:resetPluginState()` (the action) + `src/settings/tab.ts:ResetConfirmModal` (the confirmation).

### Module layout (`src/`)

```
src/
├── main.ts                          # Plugin entry, commands, ribbons, IntervalScheduler wiring
├── gi.ts                            # GI (gitignore matcher) — path-browserify, mobile-safe
├── logger.ts                        # Truncated JSON log file
├── utils.ts                         # hasTextExtension, isAtomicPluginFile gate, retry helpers, …
├── github/client.ts                 # Thin requestUrl wrapper, retryUntil + isRetriableStatus
├── settings/
│   ├── settings.ts                  # GitHubSyncSettings + DEFAULT_SETTINGS
│   └── tab.ts                       # Settings UI (trim onChange, Reset modal)
└── sync2/
    ├── sync2-manager.ts             # Entry, drain runner, conflict resolution
    ├── interval-scheduler.ts        # Periodic tick + onload startup (testable)
    ├── change-detector.ts           # Vault walk + findChanges + queue bridge
    ├── push-queue.ts                # .push-queue/ persistence + markers + meta serdes
    ├── tree-builder.ts              # Batch → tree entries (with uploadedBlobs skip)
    ├── snapshot-store.ts            # github-easy-sync-metadata.json (file name is historic)
    ├── gitignore-invariants.ts      # The three invariant .gitignore files
    ├── commit-templates.ts          # {date}/{time}/… placeholders + device suffix
    ├── conflict-store.ts            # Deferred conflicts, sibling files
    ├── conflict-merge-all.ts        # "Merge into one" resolution path
    ├── plugin-js.ts                 # isAtomicPluginFile, compareSemver, readPluginVersion
    ├── three-way-merge.ts           # mergeText (diff3-style)
    ├── text-normalize.ts            # CRLF→LF, BOM strip, trailing-NL
    ├── types.ts                     # QueueBatch, FileChange, EnqueueMeta, …
    └── views/                       # ConflictView, DiffPane, CommitMessageModal
```

### Test layout (`tests/integration/scenarios/sync2/`)

```
sync2/
├── bootstrap/             # A1, A2: bare-repo bootstrap + 10-iter stress
├── adoption/              # B1–B7: first sync against non-bare remote (B7 = interrupted-resume with canonicalize ON)
├── normalization/         # C1, C2, C3 (resume) + CRLF/BOM round-trips
├── incremental/           # D1–D8: post-adoption + delete races
├── conflicts-misc/        # E1–E4: reconcile-onload, binary atomic, plugin-js semver/mtime
├── edges/                 # F: special chars in paths + content edge cases
├── multi-device/          # G1–G4: rotation, disjoint edits, same-line, binary atomic
├── drift/                 # H1–H4: web-UI modify, PATCH retry, concurrent syncAll, OOB rename
├── settings-lifecycle/    # I1–I6: reset metadata, syncConfigDir toggle, deviceLabel change, pull-side OFF, repo-switch auto-detect
├── api-failures/          # J1–J4: invalid token, 429 retry, wrong repo, network drop
├── manifest-corruption/   # K1–K5: invalid JSON, deleted, stale lastSync, unknown fields, empty files map
├── accumulate/            # L1–L4: accumulate semantics + attempted-marker
├── conflicts/             # ConflictStore-driven deferred-conflict tests
├── gitignore/             # gitignore + rename interaction
└── empty-progression.test.ts
```

Tests use **branch-per-test** on a persistent private int-test repo (fine-grained PAT). The bootstrap suite is the exception — it needs delete+recreate to regain bare state, so it uses a public ephemeral repo with a classic PAT. See `tests/integration/helpers.ts` for env-var wiring (`integrationEnabled` / `bootstrapEnabled`). Series-by-series breakdown is in the `## Testing` section near the bottom of this file.

### Things the engine deliberately does NOT do

- No event-listener (polling is enough and simpler; no missed-events failure mode).
- No legacy-manifest migration on adoption (anything that needs sync history must run a sync via the previous tool first).
- No state-machine routing. Branching lives inside `processBatch` (Cases 1–4) and `applyRemoteAddOrModify` / `reconcileBatchAgainstHead`.
- No `republishPaths` / `appendRepublishChanges` / `synthesizeRepublishChange` (replaced by canonicalize-without-recordSync: the next findChanges picks up the divergence naturally).
- No eager click-time "Syncing with GitHub…" notice. Progress notice opens lazily inside drain only when a phase is heavy enough; idle syncs run silent.
- No "delete wins" for delete-vs-modify (replaced by conflict resolution that lets the user keep delete, keep remote, merge, or defer).
- No scheduler logic in `main.ts`. The periodic-tick and onload-startup decisions live in `IntervalScheduler` so they can be unit-tested.

## Testing

Three independent test suites — each lives in its own directory, has its own vitest config, and is invoked via its own `pnpm` script. Every test runs against the same `mock-obsidian.ts` alias (fs-backed vault stand-in); integration + perf tests reach the real GitHub API on top of that.

| Suite | Scope | Network | Command | Wall-clock |
|---|---|---|---|---|
| Unit | Pure helpers, snapshot/queue/store invariants, classifiers | No | `pnpm test` (single) / `pnpm test:watch` (re-run) | ~4 s |
| Integration | `Sync2Manager` end-to-end via real GitHub | Yes | `pnpm test:integration` (full) and the two split scripts below | ~19 min full |
| Perf baselines | Wall-clock signal on real GitHub upload paths | Yes | `pnpm test:perf` | ~1 min |

Build sanity (`pnpm build`) runs `tsc -noEmit` before bundling — keep it green; CI runs the same on tag pushes.

### Unit suite (`tests/sync2/` + `tests/gi.test.ts`, `pnpm test`)

18 spec files, 429 cases, ~4 s. Mocks the `obsidian` module via `vitest.config.ts` alias → `mock-obsidian.ts`. No network, no GitHub PAT required — runs anywhere `pnpm install` succeeded.

What's covered:

| File | What it pins |
|---|---|
| `tests/gi.test.ts` | `GI` (gitignore matcher): rule precedence, path-prefix scoping, mtime-driven re-parse skip |
| `tests/sync2/change-detector.test.ts` | `findChanges` watermark + stat-cache + SHA short-circuit; `isSyncable` deny list incl. configDir gate |
| `tests/sync2/chunk-actions.test.ts` | Per-chunk apply / revert in the merge view |
| `tests/sync2/commit-templates.test.ts` | `{date}` / `{time}` / `{filename}` / `{path}` substitution + `appendDeviceSuffix` |
| `tests/sync2/conflict-merge-all.test.ts` | "Merge into one" path: copies stack, headers, ordinal numbering |
| `tests/sync2/conflict-modal.test.ts` | Buttons → resolution shape mapping |
| `tests/sync2/conflict-status-bar.test.ts` | 🔀 status-bar count + click-through |
| `tests/sync2/conflict-store.test.ts` | Sibling filename generation, pending-conflict serdes, notify-on-delete |
| `tests/sync2/conflict-view.test.ts` | Merge-view leaf wiring, dep injection |
| `tests/sync2/gitignore-invariants.test.ts` | `enforce()`, `spliceInvariantBlock`, `extractInvariantBlock`, `blockHasAllowLine`; "Push plugins data.json" toggle state encoded in block |
| `tests/sync2/plugin-js.test.ts` | `isAtomicPluginFile`, `compareSemver`, `readPluginVersion` |
| `tests/sync2/push-queue.test.ts` | Batch persistence, markers (`.in-progress` / `.attempted`), `uploadedBlobs` |
| `tests/sync2/snapshot-store.test.ts` | `migrate()` defensive coercion, `clear()`, `setLastSync`, invariant-state slot |
| `tests/sync2/sync2-manager.test.ts` | The orchestrator under a fake `GithubClient` — bootstrap routing, conflict-resolution dispatch, processBatch Cases 1–4, drain entry-point bootstrap guard |
| `tests/sync2/text-normalize.test.ts` | CRLF→LF, BOM strip, trailing-NL canonicalisation |
| `tests/sync2/three-way-merge.test.ts` | `mergeText` (diff3-style) — clean merges + conflict-marker shape |
| `tests/sync2/tree-builder.test.ts` | Batch → tree entries, `uploadedBlobs` skip, `Promise.allSettled` over `createBlob` |
| `tests/sync2/interval-scheduler.test.ts` | start/stop, cadence selection (interval-min vs watchdog 5-min), all `fullCycle` branches × 2 entry points (tick / startup), watchdog empty-queue no-op, error-swallow with correct log label, fake-timer fire integration |

Run a single spec:
```
pnpm vitest run tests/sync2/push-queue.test.ts
```

### Integration suite (`tests/integration/`, `pnpm test:integration`)

~65 test files, ~106 cases (some `it.each` unfold further at runtime), ~19 min full wall-clock (bootstrap suite makes up ~3 min of that; non-bootstrap ~17 min). Real GitHub round-trips on every test; `vitest.integration.config.ts` loads `.env.test` from repo root, aliases `obsidian` to `mock-obsidian.ts` exactly like the unit suite, but does NOT bundle.

**Env vars** (`.env.test` at repo root):
- `GITHUB_TOKEN` — fine-grained PAT scoped to one private repo. Permissions: Contents R/W, Metadata R. CANNOT create or delete repos, which is intentional — leak blast radius is that one repo's contents. Used by every test except the bootstrap suite.
- `INT_TEST_OWNER` / `INT_TEST_REPO` — the private int-test repo. Each test creates a unique branch (`int-test-<scenario>-<timestamp>-<n>`) off the default branch and deletes it in `afterEach`. Default branch is bootstrapped lazily on first run via `ensureRepoNotBare`.
- `GITHUB_BOOTSTRAP_TOKEN` — classic PAT with `public_repo` + `delete_repo`. Only needed for the bootstrap suite; it has to delete + recreate a repo to get back to the bare state. The two-token split exists because fine-grained PATs can't create repos.
- `INT_BOOTSTRAP_TEST_REPO` — the public ephemeral repo the bootstrap suite recreates. `tests/integration/teardown.ts` drops it at the end of every run.
- `INT_TEST_BRANCH_PREFIX` — defaults to `int-test`; only override if multiple users share the same int-test repo.

**Run commands**:
```
pnpm test:integration              # everything (uses GITHUB_BOOTSTRAP_TOKEN if set)
pnpm test:integration:bootstrap    # just tests/integration/scenarios/sync2/bootstrap (slow — repo recreate per test)
pnpm test:integration:nonbootstrap # everything else (no GITHUB_BOOTSTRAP_TOKEN required)
pnpm vitest run --config vitest.integration.config.ts tests/integration/scenarios/sync2/<bucket>
```
The bucket form takes a glob — `tests/integration/scenarios/sync2/conflicts*` runs both `conflicts/` and `conflicts-misc/`. A single file works too.

**Bucket-by-bucket** (all under `tests/integration/scenarios/sync2/`):

| Bucket | Series | What it pins |
|---|---|---|
| `bootstrap/sync2-bare-repo.test.ts` | A1, A2 | Two-step bare-repo bootstrap (Contents API seed + Git Data API root commit), 10-iter stress against eventual-consistency 409. Only suite that needs the bootstrap PAT. |
| `adoption/B1-identical.test.ts` … `B7-interrupted-resume-canonicalize.test.ts` | B1–B7 | First sync against a non-bare remote: identical (B1), non-overlapping (B2), text local-newer (B3), text remote-newer (B4), binary local-newer (B5), binary remote-newer (B6), interrupted-adoption resume with canonicalize ON (B7). Non-destructive contract pinned here. |
| `normalization/` (9 files) | C1, C2, C3 + CRLF/BOM | C1 resumes bootstrap pull, C2 resumes push-blob (with remote-race variant), C3 pull-defers-to-push reconcile. CRLF/BOM/idempotency round-trips, multi-device convergence on canonicalisation, binary byte-exactness. |
| `incremental/D1-incremental-upload.test.ts` … `D8-same-file-deleted-both.test.ts` | D1–D8 | Post-adoption incremental: upload (D1), download (D2), bidirectional deletes (D3), local-delete-vs-remote-modify on different files (D4) + same file (D6 — **4 sub-tests** covering keep-delete / keep-remote / merge / defer per the delete-vs-modify conflict contract), local-modify-vs-remote-delete on different files (D5) + same file (D7, resurrection), both-sides-delete (D8). |
| `conflicts-misc/E1-reconcile-onload.test.ts` … `E4-plugin-js-same-version-mtime.test.ts` | E1–E4 | Onload reconcile after vault edits while engine was disabled (E1), binary atomic mtime (E2), plugin-js semver atomic (E3), plugin-js same-version → mtime tie-break (E4). |
| `edges/F-special-chars-and-content.test.ts` | F | Cyrillic paths + content, spaces/brackets in filenames, empty files, 1 MB long-line, 150-char filename, remote-side Cyrillic path pulled into fresh vault. 6 `it()` sub-cases in one file. |
| `multi-device/G1-three-device-rotation.test.ts` … `G4-binary-atomic-across-devices.test.ts` | G1–G4 | Three-device rotation A→B→C→A (G1), two-device disjoint same-file edits → 3-way merge (G2), same-line conflict resolved on the second pusher (G3), binary atomic mtime across two real devices (G4). |
| `drift/H1-out-of-band-modify.test.ts` … `H4-out-of-band-rename.test.ts` | H1–H4 | Web-UI edit between syncs (H1), PATCH `/git/refs` transient retry + hard-fail recovery (H2), concurrent syncAll serialized via `running` flag (H3), out-of-band delete+create rename (H4). |
| `settings-lifecycle/I1-reset-metadata.test.ts` … `I6-repo-switch-auto-detect.test.ts` | I1–I6 | Snapshot reset (I1), syncConfigDir ON→OFF (I2), OFF→ON forward-looking (I3), deviceLabel change reflected in next commit message (I4), pull-side OFF blocks incoming configDir changes (I5), owner/repo/branch change in settings auto-wipes snapshot + queue and re-adopts from new remote (I6). |
| `api-failures/J1-invalid-token.test.ts` … `J4-network-drop.test.ts` | J1–J4 | Invalid token 401 (J1), 429 backoff (J2), wrong repo 404 (J3), simulated network drop on first call (J4). Each pins fail-fast + batch persistence + recovery on next sync. |
| `manifest-corruption/K1-invalid-json.test.ts` … `K5-empty-files-map.test.ts` | K1–K5 | Garbage JSON in snapshot manifest (K1), file deleted (K2), bogus `lastSyncCommitSha` → `compare` 404 → auto-advance to live head (K3), unknown top-level + per-file fields ignored (K4), files: {} with lastSync intact (K5). |
| `accumulate/L1-sequential-clicks.test.ts`, `L4-attempted-locks-merge.test.ts` | L1, L4 | Sequential clicks fold (L1); attempted-marker locks a failed batch out of merge (L4). |
| `conflicts/` (4 files) | — | Deferred + sibling-delete close (defer-then-resolve-via-sibling-delete), merge-into-one resolver, multi-copy pair resolution, pending-conflict blocks push. |
| `gitignore/gitignore-rename-suite.test.ts` | — | gitignore-driven filtering interacting with renames. |
| `empty-progression.test.ts` | — | "Nothing in vault, nothing on remote, click sync" path stays no-op. |

**Helpers** (`tests/integration/helpers.ts`): `createBranchFromHead`, `deleteBranchIfExists`, `ensureRepoNotBare`, `getDefaultBranchHead`, `getBranchHead`, `countBranchCommits`, `getBranchCommitMessages`, `writeRemoteFile`, `readRemoteFile`, `listRemoteFiles`, `removeRemoteFile`, `getRemoteFileSha`, `uniqueBranchName`, `recreateRepo`, plus fault-injection primitives below.

**Sync2-specific helpers** (`tests/integration/scenarios/sync2/helpers.ts`): `createSync2Client`, `Sync2TestClient`, `sync2AllAndAssertNoErrors`, `sync2FileAndAssertNoErrors`. The client owns its vault temp dir by default; pass `ownsVaultPath: false` (first instance) + `ownsVaultPath: true` (second) to share a vault across two test "sessions" (E1, K*, …). Pass `autoCanonicalize: true` to opt into canonicalize for tests that exercise that codepath (the helper default is `true` for back-compat with existing C-series tests; production default is `false`).

**Fault injection** (`mock-obsidian.ts` `RequestFaultInjector` + helpers exported from `tests/integration/helpers.ts`):
- `failOnNthMatch(matcher, n, message)` — throws on the Nth matching call. Used by H2, J4, plus several normalization-resume tests.
- `respondForFirstN(matcher, n, fakeResponse)` — short-circuits the first N matching calls with a synthesized HTTP response. Used by H2 (503 on PATCH) and J2 (429 on createTree) to exercise retryUntil without rate-limiting the live PAT.
- Always reset in `afterEach` via `installRequestFaultInjector(null)` — the injector is global to the vitest worker and would leak between tests otherwise.

### Perf baselines (`tests/perf/`, `pnpm test:perf`)

Opt-in, not in CI. Each test emits one `PERF_BASELINE {"name":...,"ms":...,...}` line on stdout — the `PERF_BASELINE` prefix is a sentinel a future regression script can grep for. **Nothing fails on slow runs** (perf is signal, not a gate). Reuses the integration env (same fine-grained PAT + `INT_TEST_REPO`).

Run all:
```
pnpm test:perf
```
Run a single baseline:
```
pnpm vitest run --config vitest.perf.config.ts tests/perf/p2-large-blob-upload.test.ts
```

| File | Name(s) emitted | What it measures |
|---|---|---|
| `tests/perf/p1-bulk-text-upload.test.ts` | `P1-100`, `P1-250`, `P1-500` | Bulk text upload at three sizes (parametric `it.each`). Times the second sync (the bulk push), not the priming first sync. Inline-into-`createTree` path. |
| `tests/perf/p2-large-blob-upload.test.ts` | `P2-10MB` | Single 10 MB binary through `createBlob` (~13.4 MB base64 in body). Catches createBlob HTTP / base64 regressions. |
| `tests/perf/p3-many-small-binaries.test.ts` | `P3-50bin` | 50 × ~1 KB deterministic binaries in one sync. Stresses TreeBuilder's `Promise.allSettled` over createBlob — serializing the loop later would multiply this number ~50×. |
| `tests/perf/p4-a3-shaped-vault.test.ts` | `P4-A3-245` | A3-shaped 245-file vault: 200 markdown notes across 10 subfolders + 30 daily-journal entries + 10 PNG attachments + 5 configDir snippets. Closer to real-user shape than P1. |

Reference baselines (single-run, local laptop, healthy network):
- P1-100 ≈ 2.6 s, P1-250 ≈ 2.8 s, P1-500 ≈ 3.4 s
- P2-10MB ≈ 8.1 s
- P3-50bin ≈ 4.2 s
- P4-A3-245 ≈ 3.4 s

`tests/perf/perf-helpers.ts` — `timed(name, extras, fn)` wraps an async block and emits the baseline; `deterministicBytes(seed, length)` generates non-compressible bytes seeded by a string so two runs produce identical SHAs (the upload-skip cache stays consistent across re-runs).

### Benchmark script (`benchmark.ts`, `pnpm benchmark`)

Predates the integration suite. Drives a real first-sync against GitHub via SSH-cloning + wiping the repo between runs. Requires `GITHUB_TOKEN`, `REPO_OWNER`, `REPO_NAME`, `REPO_BRANCH` env vars and an SSH-accessible remote (uses `git clone` over SSH to reset state). `pnpm test:integration` is usually preferred — it's faster, branch-per-test instead of repo-wide-wipe, and doesn't need SSH. Kept around for historical comparison only.

## Constraints to respect

- **Paths** always through `normalizePath` from `obsidian` before touching the adapter.
- **`main.js` at repo root** is the build output Obsidian loads (`manifest.json` points at it). It's not source.
- **Mobile support**: `isDesktopOnly: false` in `manifest.json`. Don't introduce Node-only APIs in `src/`; `benchmark.ts` and `mock-obsidian.ts` are the only Node-side files and aren't bundled. A top-level `import * as fs from "fs"` (or `path`, `os`, `crypto`, etc.) leaves a `require("fs")` at the top of the bundle (esbuild marks these as external by default) and **throws on Obsidian Mobile at module load** — there is no Node runtime in the Capacitor WebView — silently crashing the plugin during "Enable" in the community-plugins list. Two valid patterns: (a) use a pure-JS polyfill (`src/gi.ts` uses `path-browserify`; remove the polyfill's name from the esbuild `external` list so it gets bundled instead of `require`'d); or (b) wrap the require inside a function body with `try/catch` so it's never evaluated at module load — see `defaultReadFile` in `src/gi.ts` for the fs case (only test-time code path; production injects a vault-adapter reader instead). To verify, grep the production bundle: `grep -E "=require\\(\\\"fs\\\"\\)|=require\\(\\\"path\\\"\\)" main.js` must return zero matches at file scope.
- **Settings-tab text inputs must trim user input.** Android keyboards (and several third-party iOS ones) reliably append trailing whitespace to paste operations from the suggestion bar. A token like `ghp_abc123 ` (one trailing space) makes every GitHub REST call return 404 with valid permission headers — GitHub masks "valid token, repo outside scope" as 404 to avoid leaking private-repo existence, and a whitespaced token never matches the configured repo's scope. `src/settings/tab.ts` calls `.trim()` in every `onChange` for token/owner/repo/branch, and `src/main.ts:loadSettings` runs a one-pass sanitize on read so existing installs with whitespace-poisoned values self-heal on plugin restart.
- **Don't add files to the hardcoded `isSyncable` blocklist** without a real reason. The default for new "should we sync this?" rules is to add patterns to the seeded gitignore (`CONFIG_DIR_SEED` / `ROOT_SEED` in `gitignore-invariants.ts`) — that way users can opt out.
- **The conflict view UI is fragile** on mobile and long text files. Atomic resolution carries most of the load; if you add new conflict shapes, check whether they belong in the atomic path before plumbing them through the diff modal.
- **`vault.adapter.read` is for text only.** Use `readBinary` for anything `hasTextExtension` says false. Especially important on iOS where the text path silently corrupts binary content.
- **Don't hand-edit the canonical block in `<configDir>/.gitignore`** — `GitignoreInvariants.enforce()` will rewrite it on the next plugin load. To customise the truly-required behaviour, edit the constants in `gitignore-invariants.ts` and ship a new build.
