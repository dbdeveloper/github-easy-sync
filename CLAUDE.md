# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

1. Don’t assume. Don’t hide confusion. Surface tradeoffs.
2. Minimum code that solves the problem. Nothing speculative.
3. Touch only what you must. Clean up only your own mess.
4. Define success criteria. Loop until verified.

## What this plugin is

An Obsidian plugin that syncs a local vault with a GitHub repository using **only the GitHub REST API** — no `git` binary, no `isomorphic-git`. This constraint is deliberate so the plugin works identically on desktop and mobile. It means features like branching, merging, rebasing, or any non-GitHub host are out of scope.

This branch (`init-state-machine-refactoring`) sits 30+ commits ahead of upstream main. Significant architectural changes vs upstream: state-machine routing, gitignore-driven filtering, atomic conflict resolution, resume markers, atomic bare-repo bootstrap, two-way manifest↔tree reconciliation for off-band edits/deletions on GitHub, transition-detection for vaults moving over from another sync tool, and a 46-test integration suite that pins the above against real GitHub round-trips. See `git log --oneline upstream/main..HEAD` for the chain.

Behaviour described below is shaped first by an A→E manual test sweep, then locked in by the integration tests (`pnpm test:integration`). Test series A–K each correspond to a different concern — bootstrap, adoption, resume, incremental, atomic conflicts, special chars, multi-device stress, out-of-band drift, settings lifecycle, auth/API failures, manifest corruption. The conflict view UX is the one area still openly known to be primitive; everything else is intentional.

## Active engine: sync2 (Etap 7 cutover landed)

The plugin is now driven by **sync2** (`src/sync2/`). The legacy `SyncManager`, `events-listener`, `decideInitAction`, and chunk-pick conflict view are **gone from src/** (see `main.ts:42` comment). The plugin id is unchanged (`github-gitless-sync`); only the engine swapped.

## Headline design intent

**The sync tries to behave like a primitive git client — but with predictable, easy-to-explain semantics, so users know what to expect.** Sync2 deliberately rejects features a power-user might want from a real git workflow (no branches, no rebase, no manual stash) and instead picks one safe default per scenario. Concretely:

- Two-side divergence on a file → 3-way merge if there's a base, atomic mtime tie-break otherwise. Same as `git pull --no-rebase` would do, minus the conflict marker dance for the safe cases.
- File missing on one side → pulled from / pushed to the other side. Same as `git pull` / `git push` adding new objects.
- File deleted somewhere → propagates, with modify-vs-delete resolved as "local-intent-wins" (delete wins if local, resurrection wins if local-modified). Matches git-default conservativeness ("keep the change-side").
- "Adoption" (first sync against a non-bare repo with local content) is **non-destructive**: local files are NEVER overwritten without an mtime check that says remote is newer.

**Two places where sync2 intentionally diverges from "primitive git":**
- **`<configDir>/plugins/<id>/main.js` and `manifest.json`** — atomic semver resolution (read `manifest.json` from both sides, higher version wins, mtime tie-break). A 3-way merge on a minified plugin bundle produces garbage that crashes Obsidian on load, so we don't do it.
- **Binary files** — atomic mtime resolution always; no merge attempt. PNG / mp4 etc. have no useful "merge".

Everything else inherits git-shape behaviour. The detail of how each path is resolved lives below in "Sync2 architecture" → "Conflict resolution".

Read the **"Sync2 architecture"** section below before touching anything in `src/sync2/`. The original "Architecture" section further down describes the **legacy** flow — kept verbatim for context when reading old PRs or grep'ing for removed symbols, but the code is not in the repo anymore.

## Commands

Package manager is **pnpm** (CI uses `pnpm@latest-10`).

- `pnpm dev` — esbuild watch mode, emits `main.js` with inline sourcemaps. Set `OBSIDIAN_PLUGIN_DIR` env var to also mirror `main.js` / `manifest.json` / `styles.css` into a vault's plugin folder on every successful build (paths starting with `~/` are expanded). On macOS, IDE-set env vars don't pass through shell expansion — the config does that itself.
- `pnpm build` — typecheck (`tsc -noEmit`) then production bundle. Run before committing; CI runs the same on tag pushes.
- `pnpm test` — vitest, runs once and exits. ~76 unit tests covering pure helpers (isSyncable, classifyForConflict, decideInitAction's full decision table, GitignoreCache helpers, MetadataStore.load() invariants, etc.). Mocks the `obsidian` module via `vitest.config.ts` alias to `mock-obsidian.ts`.
- `pnpm test:watch` — vitest watch mode.
- `pnpm test:integration` — full integration suite (46 tests, ~9 min end-to-end). Real GitHub round-trips via the fine-grained PAT against the private int-test repo. See "Testing" below for the env vars and layout.
- `pnpm test:integration:bootstrap` — bootstrap suite only (uses the public ephemeral repo, classic PAT). Slow because each test deletes + recreates the repo.
- `pnpm test:integration:nonbootstrap` — everything except bootstrap. Cheaper because branch-per-test on the persistent int-test repo.
- `pnpm test:perf` — opt-in performance baselines under `tests/perf/`. Not part of CI; emits structured `PERF_BASELINE {…}` lines on stdout. See "Testing" below.
- `pnpm benchmark` — `benchmark.ts`: real `firstSync` against GitHub. Requires env vars `GITHUB_TOKEN`, `REPO_OWNER`, `REPO_NAME`, `REPO_BRANCH` and an SSH-accessible remote (uses `git clone` over SSH to wipe the repo between runs). Predates the integration suite; the test:integration script is usually preferred now.

Releases are triggered by pushing a tag matching `[0-9].[0-9]+.[0-9]+*` (a `-beta` suffix cuts a prerelease); `version-bump.mjs` syncs `manifest.json` and `versions.json` from `package.json`.

## Sync2 architecture (post-Etap 7)

### Entry points

`Sync2Manager` is the only orchestrator. Three top-level public methods, all idempotent; `processQueue` is guarded by a `running` flag so concurrent calls don't double-drain:

- `syncAll(customMessage?: string)` — whole-vault sync. Without `customMessage`: standard template-driven commit. With: an **isolated** batch using the user's typed message verbatim.
- `syncFile(path, customMessage?)` — single-file sync. Same custom-message split.
- `pullOnly()` — interval-driven background pull; suppresses conflict modals (any conflict defers to the next manual sync).

Wired in `main.ts` to four Obsidian commands: `Sync with GitHub`, `Sync with GitHub (custom message)…`, `Sync current file with GitHub`, `Sync current file with GitHub (custom message)…`.

### Polling model (NOT event-driven)

Sync2 does **not** register Obsidian vault events. `findChanges` (`change-detector.ts:100`) walks the whole vault on each sync call. A watermark (`SnapshotStore.lastCommitMtime`) skips unchanged files via `file.stat.mtime <= watermark` — one stat per file, content read only for the narrow candidate set.

Implication: vault edits made while the plugin was disabled get picked up on the next sync click without any "missed events" failure mode (covered by E1 test).

### PushQueue: persisted commit intent

Located at `<configDir>/plugins/github-gitless-sync/.push-queue/`. Each pending sync is a directory:

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
- `isolated: boolean` — true for custom-message batches; blocks merge in either direction.

**Marker semantics:**
- `.in-progress` set at start of `processBatch`, cleared on success (via `delete(id)`) OR failure (via `clearInProgress`).
- `.attempted` set at start of `processBatch` and **never cleared on failure** — only removed when the batch dir is deleted on commit success. Models the user's rule: "failed batch is frozen against new merges; the next sync click creates a new batch".
- `mergeIntoLatestPending` skips batches that are `in-progress` OR `attempted` OR `isolated`.

### Adoption (first sync against a non-bare remote)

`bootstrapFromRemote` (the function name is historic — what it actually does is **adoption**) is **non-destructive**. Per-file decision:

- Local missing → pull, write vault, recordSync.
- Local exists, SHA matches remote → recordSync only (no transfer, no overwrite, mtime preserved).
- Local exists, SHA differs → atomic mtime resolution:
  - `local.mtime >= remoteHeadCommit.committerDate` → **keep local**. No recordSync; findChanges later emits "added" and the next push lifts local to remote.
  - Else → pull, **overwrite local in place**, recordSync.

Local-only files (in vault, not in remote tree) are untouched here; findChanges picks them up post-adoption as "added".

Tie on mtime → local wins. No "deleted-on-this-device" detection (no history); README must instruct users to pre-sync via their previous tool. Covered by **B1–B6** tests under `tests/integration/scenarios/sync2/adoption/`.

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

### Resume strategies (three layers)

1. **Pull-side resume** (`bootstrapFromRemote`): the per-file loop skips `getBlob` when the local file exists with the SHA the tree announces. A bootstrap that crashed after 6 of 50 files re-runs and only fetches 7–50.

2. **Push-side resume** (`tree-builder.ts` + `PushQueue.uploadedBlobs`): after each `createBlob` success, TreeBuilder calls `queue.recordBlobUpload(id, path, sha)`. On retry of the same batch, paths in `uploadedBlobs` skip the `createBlob` call and use the cached SHA inline. Serialized through `metaWriteQueue` so `Promise.allSettled` callbacks don't clobber each other.

3. **findChanges-vs-queue bridge** (`change-detector.ts:findChanges`): before emitting "added"/"modified", consults `queue.peekPathSha(path)`. If a pending batch already holds this path with the local-computed SHA, **skip emit**. This is what stops "second sync after a crash" from creating a duplicate batch — regardless of the `accumulateOfflineSyncs` setting. The matching path stays in B1 until B1 commits.

### Conflict resolution

`applyRemoteAddOrModify` dispatches by path shape:

| Path shape | Path examples | Resolution |
|---|---|---|
| Non-text | `*.png`, `*.pdf`, etc. | `resolveBinaryConflict` — atomic mtime, tie → local |
| Plugin file | `<configDir>/plugins/<id>/main.js` OR `…/manifest.json` (any depth) | `resolvePluginJsConflict` — semver from plugin's `manifest.json`, fallback to mtime on tie/parse-fail |
| Other text | everything else with `hasTextExtension(path)` | 3-way merge against `expectedHead`; conflict → `onConflict` callback |

`isAtomicPluginFile(path, configDir)` (in `src/sync2/plugin-js.ts`) is the gate for the plugin-file branch. **Only `.js` AND `manifest.json` under a plugin folder match**; `styles.css`, README files, etc. go through standard text 3-way merge.

**Pull defers to push-side reconcile for queue-overlap paths**: `pullIfNeeded` skips `applyRemoteAddOrModify` for any path mentioned in a pending batch, and **withholds the `lastSync` advancement** so `processBatch`'s Case 4 (`reconcileBatchAgainstHead`) runs the 3-way merge against the **batch's snapshot** instead of the live vault. Without this bridge, the batch would push its stale snapshot on top of the merged remote, losing the merge result (covered by C3 test).

### Custom-message commits & accumulate semantics

- Every command that takes a custom message routes through `enqueueOrMerge({…, isolated: true})`. Isolated batches **never** absorb other changes and **never** themselves fold into a prior batch. User's typed message survives intact.
- For standard (non-isolated) syncs with `accumulateOfflineSyncs: true`: `mergeIntoLatestPending` finds the youngest pending+non-in-progress+non-attempted+non-isolated batch and folds new changes into it. After the merge, `enqueueOrMerge` calls `updateCommitMessage` so the batch's commit message reflects the **latest** click's template render — not the first.
- A failed batch is `attempted=true` → next click creates a fresh batch (not folded). Practical "accumulate" window: clicks that arrive WHILE a previous slow push is in-progress accumulate into a NEW second batch that the runner will pick up after the in-progress one finishes.
- Covered by **L1–L4** in `tests/integration/scenarios/sync2/accumulate/`.

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

The line is stand-alone — it does NOT depend on `plugins/*/*` existing elsewhere in the file. The recommended-defaults section is only seeded when WE create the gitignore from scratch; if the user already had an `.obsidian/.gitignore` before installing sync2, only our invariant block goes in at the top and nothing else is added below. So OFF state has to carry an explicit block rule, not rely on a sibling catch-all.

The gitignore IS synced across devices, so this toggle is implicitly **shared cross-device**: whichever device last pushed the gitignore wins, and on the next sync every other device's checkbox flips to match. No separate per-device field, no ping-pong, no drift.

Implementation:
- `configDirInvariantBlock({ pushPluginsDataJson })` is the single function that builds the canonical block — both for `enforce()` and for the toggle. The block is ALWAYS rewritten in place via `spliceInvariantBlock`; it can't multiply, drift, or end up in user territory.
- `GitignoreInvariants.getPushPluginsDataJson()` reads the file, extracts the body between BEGIN/END markers via `extractInvariantBlock`, and tests for the `!`-prefixed line via `blockHasAllowLine`. Returns `false` (OFF) on missing file or malformed block.
- `GitignoreInvariants.setPushPluginsDataJson(enabled)` builds the canonical block with the requested state, splices it into the file. Idempotent — if the spliced result equals the existing content, no write happens.
- `enforce()` preserves the toggle state on every rewrite: it reads the current state from the existing block first, then writes the canonical version with that same state. Without this, a routine enforce() would clobber the user's toggle.

Settings-tab UI peculiarity: `toggle.setValue(v)` called from an **async** context (a `.then()` callback) triggers an infinite re-entry inside Obsidian's settings pipeline that freezes the renderer at 100% CPU. The cause is in Obsidian internals, not our code (verified by replacing the I/O with a static `Promise.resolve(true).then(toggle.setValue)` — still froze). Workaround: read the toggle state ONCE at `onload` and cache on `plugin.pushPluginsDataJsonCached`; the settings tab uses the cached value **synchronously** in `display()`. The cache stays fresh because every successful `setPushPluginsDataJson` call from `onChange` also updates the cache. The drawback — if a peer device pushes a toggled gitignore between sessions, our cache is stale until the next `onload` — is acceptable; the user re-opens settings to see the propagated state.

**OUR plugin's own `data.json` is ALWAYS blocked**, regardless of this toggle, by two redundant layers:
1. The self-plugin gitignore at `<configDir>/plugins/github-gitless-sync/.gitignore` (auto-rewritten on every plugin load to `* / !main.js / !manifest.json / !styles.css / !.gitignore`) — `data.json` matches `*` with no allow exception.
2. A hardcoded denylist in `isSyncable` (`change-detector.ts:29`) — defense in depth in case the self-plugin gitignore is tampered with. Our `data.json` carries the GitHub token; no toggle should ever expose it.

### Module layout (src/sync2/)

```
src/sync2/
├── sync2-manager.ts        # entry, queue runner, conflict resolution
├── change-detector.ts      # vault walk + findChanges + queue bridge
├── push-queue.ts           # .push-queue/ persistence + markers + meta serdes
├── tree-builder.ts         # batch → tree entries (with uploadedBlobs skip)
├── snapshot-store.ts       # github-easy-sync-metadata.json (file name is historic)
├── gitignore-invariants.ts # the three invariant .gitignore files
├── commit-templates.ts     # {date}/{time}/… placeholders + device suffix
├── conflict-store.ts       # deferred conflicts, sibling files (Etap 6.5)
├── conflict-merge-all.ts   # merge-into-one resolution path
├── plugin-js.ts            # isAtomicPluginFile, compareSemver, etc.
├── three-way-merge.ts      # mergeText (diff3-style)
├── text-normalize.ts       # CRLF→LF, BOM strip, trailing-NL
├── types.ts                # QueueBatch, FileChange, EnqueueMeta, …
└── views/                  # ConflictView, DiffPane, CommitMessageModal
```

### Test layout (tests/integration/scenarios/sync2/)

```
sync2/
├── bootstrap/             # A1, A2: bare-repo bootstrap + 10-iter stress
├── adoption/              # B1–B6: first sync against non-bare remote
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
├── conflicts/             # ConflictStore-driven deferred-conflict tests (Etap 6.5)
├── gitignore/             # gitignore + rename interaction (covers legacy E4)
└── empty-progression.test.ts
```

Tests use **branch-per-test** on a persistent private int-test repo (fine-grained PAT). The bootstrap suite is the exception — it needs delete+recreate to regain bare state, so it uses a public ephemeral repo with a classic PAT. See `tests/integration/helpers.ts` for env-var wiring (`integrationEnabled` / `bootstrapEnabled`). The detailed series-by-series breakdown lives in the `## Testing` section near the bottom of this file.

### "Sync configs" toggle (`syncConfigDir`)

Per-device gate for paths under `<configDir>/`. Lives in `data.json` (per-device by design — that file is hard-blocked from sync, so the setting can't propagate). **Default `false`** (explicit opt-in). Obsidian configs include workspace state, theme settings, and plugin install state; many users (especially multi-device users) don't want one machine's layout overwriting another's, so the safe default is OFF and the user opts in via the settings tab.

When OFF, `isSyncable` returns `false` for every path under `<configDir>/` — fully symmetric, both push and pull. The two invariant gitignore files (`<configDir>/.gitignore` and `<configDir>/plugins/<self>/.gitignore`) are NOT exempt: each device keeps its own canonical via `GitignoreInvariants.enforce()` on plugin load, so cross-device propagation of those files isn't needed.

Threaded through as a live getter — `() => settings.syncConfigDir` — so flipping the toggle in the settings tab takes effect on the very next `syncAll` without rebuilding the manager. The detector consults it via `checkSyncable(path)` for both push (`findChanges`) and pull (`applyRemoteAddOrModify`).

**Enumeration**: production Obsidian's `vault.getFiles()` does NOT index files under `<configDir>/` (legacy bug confirmed against a real vault: `getFiles()` returned `Welcome.md` but skipped `.obsidian/.gitignore`). When the toggle is ON, `findChanges` additionally walks `<configDir>/` via `adapter.list()` recursively to surface those paths. When OFF, the walk is skipped entirely — no extra syscalls.

**OFF → ON is forward-looking.** When OFF, a remote change to a configDir path is filtered by the gate but `lastSync` still advances to current `HEAD` (the gate filters the file, not the commit). Toggling ON later does NOT retroactively pull configDir paths that drifted on remote during the OFF window — `compare(lastSync, HEAD)` returns empty. The next remote change to those paths after toggle ON does pull as normal. Matches a `git update-index --skip-worktree` analogue: unskipping doesn't retroactively pull, only forward changes do. Covered by I3.

### Remote identity tracking

The snapshot store records the `(owner, repo, branch)` triplet it was last reconciled against. `Sync2Manager.reconcileRemoteIdentity()` runs at the very start of every `syncAll`/`syncFile`/`pullOnly` — BEFORE `bootstrapIfNeeded` and `pullIfNeeded` — and compares the recorded triplet to current settings:

- **First observation** (`remoteIdentity == null`, e.g. an upgrade from an older sync2 version): record current settings, don't reset. Existing `lastSync` state stays intact.
- **Matching triplet**: no-op.
- **Mismatch** (user edited owner/repo/branch in the settings tab): wipe `SnapshotStore` + `PushQueue` + `ConflictStore`, record new identity. The rest of `syncAll` then routes through `bootstrapFromRemote` (adoption) against the new remote because `lastSyncCommitSha` is null.

All three components — owner, repo, branch — are treated equally. A bare branch change triggers the same wipe as a full repo change: the previous `lastSync` commit isn't on the new branch and `compare` would 404 or return wrong diff. This intentionally trades "branch switching costs a full re-adopt" against "branch switching never silently leaks content from one branch to another". Covered by I6 + unit tests in `tests/sync2/sync2-manager.test.ts` under `reconcileRemoteIdentity`.

Why "wipe push-queue too": pending batches on disk reference the *previous* repo's parent SHAs. If we kept them across a repo switch, the next push would either fail (wrong parent on the new repo) or silently push wrong content. Wiping the queue is the only safe option.

### "Reset" settings button

Panic-button in the settings tab under "Danger zone". Two-step confirmation modal (user types `RESET` to enable the confirm button). On confirm: wipes `settings` to `DEFAULT_SETTINGS` (clears GitHub token, owner, repo, branch, etc.) + `SnapshotStore.clear()` + `PushQueue.clearAll()` + `ConflictStore.clearAll()`. Local vault files are NOT touched.

Use cases the design supports:
- Token rotation after a suspected leak — kills the in-flight push before the new owner of the token can intercept it.
- Manual fresh-clone setup before reconfiguring against a different repo (the auto-detect handles the common case; Reset is for "I want to nuke everything").
- Troubleshooting "something feels wrong" without uninstalling.

Implemented in `main.ts:resetPluginState()` (the action) + `src/settings/tab.ts:ResetConfirmModal` (the confirmation).

### Things sync2 deliberately does NOT do

- No event-listener (polling is enough and simpler; no missed-events failure mode).
- No legacy-manifest migration on adoption (anything that needs sync history must run a sync via the previous tool first).
- No state-machine routing (`decideInitAction` and friends are gone). Branching lives inside `processBatch` (Cases 1–4) and `applyRemoteAddOrModify`.
- No legacy "atomic plugin .js + conflict-sibling backup" `.conflict-(local|remote)-…` files (sync2 has Etap 6.5 conflict-sibling files with a different naming scheme: `.conflict-from-<label>-<iso-no-colons>Z<ext>`; these stay strictly local via the root gitignore invariant block).

## Legacy architecture (pre-cutover, historical only — code is gone from src/)

The sections that follow describe the engine as it existed before the Etap 7 cutover. The code (`sync-manager.ts`, `sync-state.ts`, `metadata-store.ts`, `events-listener.ts`, the `decideInitAction` state machine, the chunk-pick conflict view) is **no longer in the repo**. Documentation is kept here so:

- old PRs / commit messages remain readable;
- removed symbols can be grep'd from this file;
- inherited concepts (manifest as wire protocol, commit-message format with device suffix, invariant gitignores) trace back to their original design rationale.

The **active** flow is described above in "Sync2 architecture".

## Architecture

### One entry point, state machine routes the rest

`SyncManager.sync()` is the only public method to call. Inside it:

1. Refresh the gitignore cache if files changed.
2. `dispatchSync()`:
   a. Read resume markers (`firstSyncFromRemoteInProgress`, `firstSyncFromLocalInProgress`).
   b. `analyzeLocalState()` + `analyzeRemoteState()` (in parallel) classify each side as `empty` / `has-manifest` / `has-content-no-manifest` (local) or `bare` / `has-manifest` / `has-content-no-manifest` (remote).
   c. `decideInitAction()` (pure, in `sync-state.ts`) maps the (local, remote, resume) tuple to one of: `regular-sync`, `bootstrap-empty`, `first-sync-from-local`, `first-sync-from-remote`, `needs-adoption-analysis`, `adopt`, `ambiguous`.
   d. For `needs-adoption-analysis`: hash every local syncable file, intersect with remote tree SHAs, partition into identical/local-only/remote-only/conflicting. A post-step reclassifies any conflict whose remote SHA matches the recorded pre-rewrite SHA of `<configDir>/.gitignore` (see `Metadata.preExistingGitignoreShas` below) from `conflicting` to `localOnly` — the divergence is just our `INVARIANT_BLOCK` having been prepended. `shouldAutoAdopt` returns true iff `conflicting.length === 0` → silent adopt + auto-reconcile via regular sync. Otherwise emit `ambiguous`.
   e. For `ambiguous`: fire the `onAmbiguousState` callback (wired to `InitDecisionModal` in main.ts) with the analysis. The user picks "Keep local" / "Keep remote" / "Cancel".
   f. `executeInitAction(action)` calls the matching helper.

The old `settings.firstSync` boolean used to gate routing in main.ts. It now lives only as a backward-compat field — `main.ts:sync()` clears it after the first successful sync but never reads it.

#### "Has manifest" is keyed off `lastSync > 0`, not file existence

`MetadataStore.load()` writes an empty manifest to disk on every plugin load (so other call sites can rely on the file being there). That means the file's mere presence is *not* a reliable "prior sync happened" signal — a brand-new vault that's just had the plugin enabled already has the manifest on disk, and the events listener can have populated entries for files Obsidian/plugins create during init (Welcome.md, our `.gitignore` files, configDir defaults). `analyzeLocalState` reads `lastSync` from the manifest; only `lastSync > 0` (the field is only set inside `commitSync`) qualifies as `has-manifest`. Without this, the routing thinks regular sync applies and tries to upload the local infra files over the remote's user notes.

#### "Empty vault" means "only auto-managed infra"

When `lastSync == 0`, `analyzeLocalState` strips the following before deciding emptiness:
- `Welcome.md` (Obsidian creates it on every new vault).
- The 3 `.gitignore` paths we manage — but **only if we created them**. Tracked in `Metadata.pluginCreatedGitignores`. A user-authored `.gitignore` that pre-existed counts as real content (so transitioning a vault that already had its own `.gitignore` doesn't get bulldozed silently).
- Everything inside `<configDir>/` — it's all editor-managed state.
- Files inside `<configDir>/plugins/<our-plugin-id>/` — our own install. Files under any *other* plugin's folder count as user content (the user installed those plugins).

If the residue is empty, the vault routes to `bootstrap-empty` (when remote is bare) or `first-sync-from-remote` (when remote already has content) without prompting. This is the "I just installed the plugin, please pull my notes from another machine" path.

### What gets synced: tiny hardcoded set + user-managed gitignore

`isSyncable(filePath, configDir, syncConfigDir, gitignoreMatcher)` (in `src/utils.ts`) is the single source of truth, used by everything that needs to filter (events listener, sync actions, state analysis, adoption comparison, reconcile). The hardcoded portion is intentionally minimal:

1. The plugin's manifest (`<configDir>/github-sync-metadata.json`) — always allowed.
2. Our own plugin's `data.json` — never (security: it stores the GitHub token).
3. Anything inside a `.git/` directory at any depth — never (repo internals).
4. Whatever the gitignore matcher rejects — never.
5. Inside `<configDir>/`: gated on `syncConfigDir`.
6. Otherwise allowed.

Three gitignore files drive rule 4. They're managed by `GitignoreCache` (`src/gitignore-cache.ts`):

- **`<vault-root>/.gitignore`** — created with seeded defaults (OS noise, editor backups, `*.conflict-*` backups) only when no root .gitignore exists. After creation, fully user-controlled.
- **`<configDir>/.gitignore`** — has a canonical "invariants" block at the top that the plugin rewrites if tampered with. The block forces the manifest and `.gitignore` files to sync, and forces `workspace.json`, `workspace-mobile.json`, `community-plugins.json` to never sync. Below the block, on first creation only, a default seed includes `*.log` and a plugin folder allowlist (`plugins/*/data.json`, `main.js`, `manifest.json`, `styles.css`). Users can edit anything below the block.
- **`<configDir>/plugins/<self>/.gitignore`** — rewritten as-is on every onload to `* / !.gitignore / !main.js / !manifest.json / !styles.css`, strictly blocking our own data.json from leaking out (defense-in-depth on top of the hardcoded rule). `!.gitignore` is necessary so the file syncs to other devices and the rule propagates.

The cache loads all three at plugin onload (`gitignoreCache.initialize()`), refreshes only files whose `mtime` changed (`refreshIfChanged()` before each sync), and combines them into one matcher with paths re-prefixed for scope (root rules apply everywhere, configDir rules to paths under `<configDir>/`, plugin-self rules to paths under that plugin folder).

### Manifest as the wire protocol

`MetadataStore` (`src/metadata-store.ts`) defines `github-sync-metadata.json`. It tracks `{ sha, lastModified, dirty, justDownloaded, deleted, deletedAt }` per file plus several per-device fields:

- `firstSyncFromRemoteInProgress` / `firstSyncFromLocalInProgress` — resume markers (see "First-sync paths" below).
- `pluginCreatedGitignores: string[]` — paths of `.gitignore` files this plugin created (vs. files that pre-existed). Sticky once recorded. Drives the "empty vault" check in `analyzeLocalState`.
- `preExistingGitignoreShas: { [path]: string }` — git blob SHA of the pre-rewrite content of any `.gitignore` we modified at startup (currently just `<configDir>/.gitignore` when prepending the invariant block). Sticky on first rewrite — later auto-re-rewrites of our own block don't overwrite the original captured value, since that's the SHA we need to match against remote in the transition-from-another-tool detection.

The file is pushed to GitHub as a regular tracked file — that's how a different device discovers what was synced.

Two invariants:

- **`MetadataStore.load()` always inserts an entry for the manifest itself** in `data.files`. Several call sites (most notably `commitSync`) used to crash with TypeError if a hand-edited manifest didn't carry that entry; the invariant pushes the guard down to the only place it makes sense.
- **`commitSync` constructs the manifest tree entry from current in-memory metadata, never reading or mutating a caller-provided slot.** Callers can't forget to populate it, and they can't accidentally pass mismatched contents. All four per-device fields above are stripped from the manifest content before push — they're not shared state and shouldn't propagate.

### First-sync paths

- **`bootstrap-empty`** (both sides empty by the rules above): seed commit via `createFile(.gitignore)` (only API that works on a bare repo — Git Data API endpoints all return 409 "Git Repository is empty" until at least one ref exists), then a root commit with `createBlob`/`createTree`/`createCommit` containing `.gitignore` + manifest + (when present locally) `Welcome.md`, then `updateBranchHead({ sha, force: true })` repoints `refs/heads/<branch>` from the seed at the root commit and orphans the seed. Net effect on GitHub: a single visible commit named "Initial commit from `<deviceName>`" — looks human, doesn't betray the two-step bootstrap. Returns the freshly-built `RemoteState` so callers don't re-analyze.
- **`first-sync-from-remote`** (local empty, remote has content): per-file blob downloads via `getBlob`, batched 5 at a time. Holds at most one blob in memory — Android-friendly. Resumable: the `firstSyncFromRemoteInProgress` marker plus per-file `metadata.sha` SHA matching let an interrupted attempt skip work it already finished. The marker is cleared *after* `commitSync` returns, not before — see the "resume markers" note below.
- **`first-sync-from-local`** (vault has content, remote bare or has-content-no-manifest): mirrors the metadata's view of local files into a tree, then `commitSync` uploads. Resume optimization in `commitSync` skips `createBlob` for any binary whose Git blob SHA matches `metadata.files[path].sha` (content-addressed — match means the previous attempt already pushed it). Same post-commit marker clearing.
- **`adopt`** (both sides have content, no real conflicts after the gitignore-rewrite reclassification): builds a single tree on top of `remote.treeSha` containing the manifest blob plus uploaded local-only blobs, commits with the existing branch head as parent, and updates the ref. The follow-up `syncImpl` runs only when `analysis.remoteOnly.length > 0` — skipping it avoids the eventual-consistency window where `getRepoContent` might still see the pre-adoption tree.

#### Resume markers must clear *after* commitSync

`commitSync` persists in-memory metadata multiple times mid-flow (once for `lastSync` up front, then once per binary upload). If the calling first-sync helper cleared its `*InProgress` marker before invoking `commitSync`, those mid-flow saves would put `marker=false` on disk before the commit landed. An interrupt in that window would then leave the on-disk state looking like a successful regular sync (`lastSync > 0`, `marker=false`), and the next attempt would route through `regular-sync` instead of resume — which then sees a manifest from the old commit (the new commit didn't land) and proposes downloading dozens of "missing" files that aren't in the new tree. Both `firstSyncFromLocal` and `commitFirstSyncFromRemote` therefore clear their marker *after* `await commitSync(...)` returns, then call `metadataStore.save()` to persist the cleared state. Worst case on an interrupt between commit success and that save: resume fires once more, replays the first-sync, and the per-blob SHA skip cache makes it cheap.

### Conflict resolution

`findDivergedPaths()` (`sync-manager.ts`) classifies every diverged file into `plugin-js`, `binary`, or `text` (`classifyForConflict` in `utils.ts`). Classification is content-aware: a `.json` file with a 5 MB single-line dump comes back as `binary` because `isMergeFriendlyText` flags it (size > 2 MB or any line > 4 KB or null bytes).

- **plugin-js** (any `.js` inside `<configDir>/plugins/<id>/`): `resolveAtomicConflicts` reads both sides' `manifest.json` versions, compares with `compareSemver`, falls back to `lastModified`, and as a last resort picks local. Optionally drops a `<base>.conflict-(local|remote)-<isoTimestamp>.<ext>` next to the winner (controlled by `keepPluginConflictCopy` setting; off by default).
- **binary** (no text extension OR text-but-not-merge-friendly): timestamp resolution, then local-wins. Always drops a backup of the loser side.
- **text** (everything else): goes through the CodeMirror split/unified diff modal in `views/conflicts-resolution/`. **Known UX limitation**: the modal is chunk-only (pick left or right per chunk), with no Cancel, no "save both", and no free-form merge. Closing the modal blocks every subsequent sync until conflicts are resolved (the next sync re-detects the same divergence and re-opens the modal). Replacing this with `@codemirror/merge` (the official CM6 merge view extension) is the planned next refactor — same editor stack as Obsidian, ~20-30 KB extra bundle, gives proper free-form editing during merge.

The `*.conflict-(local|remote)-*` pattern is in the seeded root `.gitignore`, so backups stay strictly local by default. Users can opt into syncing them by removing the lines. Note: the per-self-plugin `.gitignore` (rewritten on every plugin load to a strict `* / !main.js / !manifest.json / !styles.css / !.gitignore` allowlist) blocks conflict backups inside our own plugin folder regardless of the root rule. That's deliberate — plugin-folder conflict backups would clutter the install across devices on every plugin update divergence.

### Reconcile on every onload

`SyncManager.reconcileWithVault()` runs from `loadMetadata()` on every plugin start. It walks the vault, marks any tracked-but-missing file as deleted (with `deletedAt`), and adds any on-disk-but-untracked file as a fresh entry. This catches changes that happened off the events listener's watch — disable→edit-vault→re-enable, crash recovery, files restored from backup, drag-and-drop in Finder, etc. Content-level divergence on the same path is still `findDivergedPaths`' job during sync.

### Two-way manifest↔tree reconciliation in syncImpl

`syncImpl` doesn't trust the remote manifest as the sole source of truth — it also reads the actual remote tree via `getRepoContent` and reconciles in both directions:

- **Tree → manifest, additions**: a file in the tree but absent from the manifest (e.g. a previous commit filtered it out) gets a synthesized manifest entry so it enters the action pipeline.
- **Tree → manifest, SHA refresh**: a file in the manifest with a *different* SHA than the tree gets its manifest entry's SHA updated to match the tree. Without this, a file edited directly on GitHub (web UI, `gh` CLI, third-party tooling) is invisible — the manifest still claims the pre-edit SHA, which matches the local SHA, so `determineSyncActions` sees `remoteFile.sha === localSHA` and returns "no work".
- **Manifest → tree, deletions**: a file in the manifest but absent from the tree gets marked `deleted: true, deletedAt: remoteMetadata.lastSync`. Same root cause — web-UI deletions don't update the manifest. The chosen `deletedAt` is the latest moment we can prove the file existed on the remote, so a local edit that landed *after* the last shared sync wins (resurrection upload), while a local file untouched since then loses (delete locally).

`determineSyncActions` handles deletions **before** the SHA-equality short-circuit. The previous order returned "no work" for any file whose local SHA matched the manifest's pre-deletion SHA, which silently dropped delete-propagation for unchanged files.

### Why binary vs text matters at the wire level

`hasTextExtension` (in `utils.ts`) gates a read path: text files are uploaded via `tree[].content`; anything else is read as a binary `ArrayBuffer`, base64'd, uploaded as a blob, and the tree references the blob SHA. Reading a binary file as text via `vault.adapter.read` fails on iOS — the extension check is the guardrail. **Don't call `adapter.read` on anything `hasTextExtension` returns false for.**

### Logger backstop

`Logger` (`src/logger.ts`) truncates `additional_data` to 64 KB if its serialized form exceeds that. Without this, a chatty callsite logging a full sync action list (tens of thousands of entries) used to balloon `<configDir>/github-easy-sync.log` to hundreds of MB per sync. Targeted summaries at known-large callsites (`Actions to sync`, `Found conflicts`, `Remote manifest is missing`) keep the backstop from kicking in during normal operation.

### GitHub client (`src/github/client.ts`)

Thin wrapper over Obsidian's `requestUrl` (not `fetch` — `requestUrl` avoids CORS and works identically on mobile). Every method takes `retry`/`maxRetries` and uses `retryUntil` with exponential backoff. The retry policy is centralized in `isRetriableStatus(status)` (`utils.ts`): retries 422 (state-conflict), 429 (rate limit), and 5xx (transient server). Other 4xx (401, 403, 404, etc.) short-circuit to an immediate error notice — those are configuration / auth problems where retrying just delays the inevitable. Notable:

- `createTree` accepts an optional `base_tree` (omit for fresh tree, e.g. the bootstrap root commit).
- `createCommit` accepts an optional `parent` (omit for root commit).
- `createReference` (POST `/git/refs`) for publishing a brand-new branch — kept around but unused by current code (bootstrap relies on `createFile` auto-creating the ref).
- `updateBranchHead` accepts a `force` flag. The bootstrap path uses `force: true` to repoint the branch from the seed commit to the unrelated root commit (collapsing the visible history to a single "Initial commit").
- `createFile` returns `{ blobSha, treeSha, commitSha }` parsed from the Contents API response. This is the only API that works on a bare repo (Git Data API endpoints all return 409 until a ref exists), and the SHAs in the response let us avoid the eventual-consistency race that re-fetching `getRepoContent` immediately after a write would have hit.
- `getRepoContent` logs 404/409 responses at INFO level (not ERROR) — those are the documented "bare repo" signal that `analyzeRemoteState` relies on, not a real failure.

`fetch` and HTTP `Range` requests were both tried for streaming the zipball during firstSync — `fetch` hits a CORS wall on the `codeload.github.com` redirect, `Range` is silently ignored by GitHub's CDN for dynamically-generated archives. Both confirmed dead ends; per-file blob downloads it is.

### Events listener (`src/events-listener.ts`)

Obsidian fires `create`/`modify`/`delete`/`rename` events. The listener calls into `isSyncable` (with the gitignore cache, just like SyncManager) and updates the local manifest (`dirty`, `lastModified`, `deleted`). **`justDownloaded` trick**: when `SyncManager` writes a file during download, Obsidian still fires `create`/`modify`. We pre-mark the entry; the listener sees the flag, clears it, and doesn't re-mark the file as user-modified. Listener registration is deferred to `workspace.onLayoutReady` to avoid the synthetic create flood at startup.

### Commit messages and `deviceName`

Commit messages are tagged with the per-device label from `settings.deviceName` (default `"Obsidian"`, configurable in the Sync section of settings):

- Bootstrap: `Initial commit from <deviceName>` (both the seed commit and the root commit use this — the seed gets orphaned anyway).
- Adoption: `Adopt existing vault state from <deviceName>`.
- Regular sync: `Sync from <deviceName> <ISO timestamp>`.

The setting lives only in `data.json`; it's stripped/never-touched on the remote side because `data.json` itself is hard-blocked from sync (it carries the GitHub token). Multi-device users can tell at a glance which machine produced any given commit on GitHub.

## Module layout

```
src/
├── main.ts                          // Plugin entry, ribbons, commands
├── sync-manager.ts                  // The orchestrator (~1800 lines, prime candidate for split)
├── sync-state.ts                    // Pure: LocalState/RemoteState analysis + decideInitAction
├── gitignore-cache.ts               // Loads + caches the three .gitignore files
├── metadata-store.ts                // Manifest persistence, manifest-entry invariant
├── events-listener.ts               // Vault → metadata
├── logger.ts                        // Truncated JSON logging
├── utils.ts                         // isSyncable, hashing, classifyForConflict, …
├── github/client.ts                 // requestUrl wrapper
├── settings/{settings,tab}.ts       // GitHubSyncSettings + UI
└── views/
    ├── init-decision-modal.ts       // "ambiguous" 3-button modal
    └── conflicts-resolution/        // Side-by-side diff for text-mergeable conflicts
```

`tests/` holds three suites:
- `tests/*.test.ts` — 76 unit specs over pure helpers.
- `tests/integration/` — 46 integration tests covering SyncManager orchestration end-to-end against real GitHub. See "Testing" below.
- `tests/perf/` — 4 opt-in perf baselines (P1–P4). See "Testing" below.

## Testing

Three independent test suites — each lives in its own directory, has its own vitest config, and is invoked via its own `pnpm` script. Every test runs against the same `mock-obsidian.ts` alias (fs-backed vault stand-in); integration + perf tests reach the real GitHub API on top of that.

| Suite | Scope | Network | Command | Wall-clock |
|---|---|---|---|---|
| Unit | Pure helpers, snapshot/queue/store invariants, classifiers | No | `pnpm test` (single) / `pnpm test:watch` (re-run) | ~6 s |
| Integration | Sync2Manager end-to-end via real GitHub | Yes | `pnpm test:integration` (full) and the two split scripts below | ~9 min full |
| Perf baselines | Wall-clock signal on real GitHub upload paths | Yes | `pnpm test:perf` | ~1 min |

Build sanity (`pnpm build`) runs `tsc -noEmit` before bundling — keep it green; CI runs the same on tag pushes.

### Unit suite (`tests/sync2/` + `tests/gi.test.ts`, `pnpm test`)

17 spec files, ~390 cases, ~6 s. Mocks the `obsidian` module via `vitest.config.ts` alias → `mock-obsidian.ts`. No network, no GitHub PAT required — runs anywhere `pnpm install` succeeded.

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
| `tests/sync2/push-queue.test.ts` | Batch persistence, markers (`.in-progress` / `.attempted`), `uploadedBlobs`, isolated-batch rules |
| `tests/sync2/snapshot-store.test.ts` | `migrate()` defensive coercion, `clear()`, `setLastSync`, invariant-state slot |
| `tests/sync2/sync2-manager.test.ts` | The orchestrator under a fake `GithubClient` — bootstrap routing, conflict-resolution dispatch, processBatch Cases 1–4 |
| `tests/sync2/text-normalize.test.ts` | CRLF→LF, BOM strip, trailing-NL canonicalisation |
| `tests/sync2/three-way-merge.test.ts` | `mergeText` (diff3-style) — clean merges + conflict-marker shape |
| `tests/sync2/tree-builder.test.ts` | Batch → tree entries, `uploadedBlobs` skip, `Promise.allSettled` over `createBlob` |

Run a single spec:
```
pnpm vitest run tests/sync2/push-queue.test.ts
```

### Integration suite (`tests/integration/`, `pnpm test:integration`)

60 test files, ~95 cases (some `it.each` unfold further at runtime), ~9 min full wall-clock. Real GitHub round-trips on every test; `vitest.integration.config.ts` loads `.env.test` from repo root, aliases `obsidian` to `mock-obsidian.ts` exactly like the unit suite, but does NOT bundle.

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
| `adoption/B1-identical.test.ts` … `B6-binary-remote-newer.test.ts` | B1–B6 | First sync against a non-bare remote: identical (B1), non-overlapping (B2), text local-newer (B3), text remote-newer (B4), binary local-newer (B5), binary remote-newer (B6). Non-destructive contract pinned here. |
| `normalization/` (9 files) | C1, C2, C3 + CRLF/BOM | C1 resumes bootstrap pull, C2 resumes push-blob (with remote-race variant), C3 pull-defers-to-push reconcile. CRLF/BOM/idempotency round-trips, multi-device convergence on canonicalisation, binary byte-exactness. |
| `incremental/D1-incremental-upload.test.ts` … `D8-same-file-deleted-both.test.ts` | D1–D8 | Post-adoption incremental: upload (D1), download (D2), bidirectional deletes (D3), local-delete-vs-remote-modify on different files (D4) + same file (D6), local-modify-vs-remote-delete on different files (D5) + same file (D7, resurrection), both-sides-delete (D8). |
| `conflicts-misc/E1-reconcile-onload.test.ts` … `E4-plugin-js-same-version-mtime.test.ts` | E1–E4 | Onload reconcile after vault edits while sync2 was disabled (E1), binary atomic mtime (E2), plugin-js semver atomic (E3), plugin-js same-version → mtime tie-break (E4). |
| `edges/F-special-chars-and-content.test.ts` | F | Cyrillic paths + content, spaces/brackets in filenames, empty files, 1 MB long-line, 150-char filename, remote-side Cyrillic path pulled into fresh vault. 6 `it()` sub-cases in one file. |
| `multi-device/G1-three-device-rotation.test.ts` … `G4-binary-atomic-across-devices.test.ts` | G1–G4 | Three-device rotation A→B→C→A (G1), two-device disjoint same-file edits → 3-way merge (G2), same-line conflict resolved on the second pusher (G3), binary atomic mtime across two real sync2 devices (G4). |
| `drift/H1-out-of-band-modify.test.ts` … `H4-out-of-band-rename.test.ts` | H1–H4 | Web-UI edit between syncs (H1), PATCH `/git/refs` transient retry + hard-fail recovery (H2), concurrent syncAll serialized via `running` flag (H3), out-of-band delete+create rename (H4). |
| `settings-lifecycle/I1-reset-metadata.test.ts` … `I6-repo-switch-auto-detect.test.ts` | I1–I6 | Snapshot reset (I1), syncConfigDir ON→OFF (I2), OFF→ON forward-looking (I3), deviceLabel change reflected in next commit message (I4), pull-side OFF blocks incoming configDir changes (I5), owner/repo/branch change in settings auto-wipes snapshot + queue and re-adopts from new remote (I6). |
| `api-failures/J1-invalid-token.test.ts` … `J4-network-drop.test.ts` | J1–J4 | Invalid token 401 (J1), 429 backoff (J2), wrong repo 404 (J3), simulated network drop on first call (J4). Each pins fail-fast + batch persistence + recovery on next sync. |
| `manifest-corruption/K1-invalid-json.test.ts` … `K5-empty-files-map.test.ts` | K1–K5 | Garbage JSON in snapshot manifest (K1), file deleted (K2), bogus `lastSyncCommitSha` → `compare` 404 → auto-advance to live head (K3), unknown top-level + per-file fields ignored (K4), files: {} with lastSync intact (K5). |
| `accumulate/L1-sequential-clicks.test.ts` … `L4-attempted-locks-merge.test.ts` | L1–L4 | Sequential clicks fold (L1), custom-message stays isolated (L2), syncAll with custom message (L3), attempted-marker locks a failed batch out of merge (L4). |
| `conflicts/` (4 files) | Etap 6.5 | Deferred + sibling-delete close (defer-then-resolve-via-sibling-delete), merge-into-one resolver, multi-copy pair resolution, pending-conflict blocks push. |
| `gitignore/gitignore-rename-suite.test.ts` | — | gitignore-driven filtering interacting with renames. Covers what was legacy E4. |
| `empty-progression.test.ts` | — | "Nothing in vault, nothing on remote, click sync" path stays no-op. |

**Helpers** (`tests/integration/helpers.ts`): `createBranchFromHead`, `deleteBranchIfExists`, `ensureRepoNotBare`, `getDefaultBranchHead`, `getBranchHead`, `countBranchCommits`, `getBranchCommitMessages`, `writeRemoteFile`, `readRemoteFile`, `listRemoteFiles`, `removeRemoteFile`, `getRemoteFileSha`, `uniqueBranchName`, `recreateRepo`, plus fault-injection primitives below.

**Sync2-specific helpers** (`tests/integration/scenarios/sync2/helpers.ts`): `createSync2Client`, `Sync2TestClient`, `sync2AllAndAssertNoErrors`, `sync2FileAndAssertNoErrors`. The client owns its vault temp dir by default; pass `ownsVaultPath: false` (first instance) + `ownsVaultPath: true` (second) to share a vault across two test "sessions" (E1, K*, …).

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

Reference baselines (single-run, local laptop, healthy network, May 2026):
- P1-100 ≈ 2.6 s, P1-250 ≈ 2.8 s, P1-500 ≈ 3.4 s
- P2-10MB ≈ 8.1 s
- P3-50bin ≈ 4.2 s
- P4-A3-245 ≈ 3.4 s

`tests/perf/perf-helpers.ts` — `timed(name, extras, fn)` wraps an async block and emits the baseline; `deterministicBytes(seed, length)` generates non-compressible bytes seeded by a string so two runs produce identical SHAs (the upload-skip cache stays consistent across re-runs).

### Benchmark script (`benchmark.ts`, `pnpm benchmark`)

Predates the integration suite. Drives a real first-sync against GitHub via SSH-cloning + wiping the repo between runs. Requires `GITHUB_TOKEN`, `REPO_OWNER`, `REPO_NAME`, `REPO_BRANCH` env vars and an SSH-accessible remote (uses `git clone` over SSH to reset state). `pnpm test:integration` is usually preferred over this — it's faster, branch-per-test instead of repo-wide-wipe, and doesn't need SSH. Kept around for historical comparison only.

## Constraints to respect

- **Paths** always through `normalizePath` from `obsidian` before touching the adapter.
- **`main.js` at repo root** is the build output Obsidian loads (`manifest.json` points at it). It's not source.
- **Mobile support**: `isDesktopOnly: false` in `manifest.json`. Don't introduce Node-only APIs in `src/`; `benchmark.ts` and `mock-obsidian.ts` are the only Node-side files and aren't bundled.
- **Don't add files to the hardcoded `isSyncable` blocklist** without a real reason. The default for new "should we sync this?" rules is to add patterns to the seeded gitignore (`CONFIG_DIR_SEED` / `ROOT_SEED` in `gitignore-cache.ts`) — that way users can opt out.
- **Don't ship per-device manifest fields to remote**. `commitSync` and the bootstrap/adoption helpers strip `firstSyncFromRemoteInProgress`, `firstSyncFromLocalInProgress`, `pluginCreatedGitignores`, and `preExistingGitignoreShas` from the manifest content before push. They're per-device progress markers / install metadata, not shared state. If you add a new manifest field of this kind, add it to the strip list in all three places (search for `delete manifestForRemote.`).
- **The conflict view UI is fragile** on mobile and long text files. Atomic resolution carries most of the load; if you add new conflict shapes, check whether they belong in the atomic path before plumbing them through the diff modal.
- **`vault.adapter.read` is for text only.** Use `readBinary` for anything `hasTextExtension` says false. Especially important on iOS where the text path silently corrupts binary content.
- **Don't hand-edit the canonical block in `<configDir>/.gitignore`** — `GitignoreCache.initialize()` will rewrite it on the next plugin load. To customise the truly-required behaviour, edit the constants in `gitignore-cache.ts` and ship a new build.
