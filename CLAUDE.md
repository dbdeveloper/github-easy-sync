# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this plugin is

An Obsidian plugin that syncs a local vault with a GitHub repository using **only the GitHub REST API** — no `git` binary, no `isomorphic-git`. This constraint is deliberate so the plugin works identically on desktop and mobile. It means features like branching, merging, rebasing, or any non-GitHub host are out of scope.

This branch (`init-state-machine-refactoring`) sits 30+ commits ahead of upstream main. Significant architectural changes vs upstream: state-machine routing, gitignore-driven filtering, atomic conflict resolution, resume markers, atomic bare-repo bootstrap, two-way manifest↔tree reconciliation for off-band edits/deletions on GitHub, transition-detection for vaults moving over from another sync tool, and a 46-test integration suite that pins the above against real GitHub round-trips. See `git log --oneline upstream/main..HEAD` for the chain.

Behaviour described below is shaped first by an A→E manual test sweep, then locked in by the integration tests (`pnpm test:integration`). Test series A–K each correspond to a different concern — bootstrap, adoption, resume, incremental, atomic conflicts, special chars, multi-device stress, out-of-band drift, settings lifecycle, auth/API failures, manifest corruption. The conflict view UX is the one area still openly known to be primitive; everything else is intentional.

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

`Logger` (`src/logger.ts`) truncates `additional_data` to 64 KB if its serialized form exceeds that. Without this, a chatty callsite logging a full sync action list (tens of thousands of entries) used to balloon `<configDir>/github-sync.log` to hundreds of MB per sync. Targeted summaries at known-large callsites (`Actions to sync`, `Found conflicts`, `Remote manifest is missing`) keep the backstop from kicking in during normal operation.

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

### Integration suite (`tests/integration/`, `pnpm test:integration`)

46 tests across 39 files, ~9 min wall-clock. Real GitHub round-trips through the same `mock-obsidian.ts` alias the unit suite uses (it's fs-backed; the mock is a real-vault stand-in, not a mock of GitHub).

**Env vars** (`.env.test` at repo root, loaded by `vitest.integration.config.ts`):
- `GITHUB_TOKEN` — fine-grained PAT scoped to a single private repo. Permissions: Contents R/W, Metadata R. CANNOT create or delete repos, which is intentional — limits leak blast radius to that one repo's contents. Used by every test except the bootstrap suite.
- `INT_TEST_OWNER` / `INT_TEST_REPO` — points at the private int-test repo. Each test creates a unique branch (`int-test-<scenario>-<timestamp>-<n>`) off default and deletes it in `afterEach`. The default branch is bootstrapped lazily on first run via `ensureRepoNotBare`.
- `GITHUB_BOOTSTRAP_TOKEN` — classic PAT with `public_repo` + `delete_repo`. Required only for the bootstrap suite, which has to delete + recreate a repo to get back to the bare state. Two-token split because fine-grained PATs can't create repos.
- `INT_BOOTSTRAP_TEST_REPO` — the public ephemeral repo the bootstrap suite recreates. `tests/integration/teardown.ts` deletes it after every run so the public-repo-with-classic-PAT exposure window is bounded by the test run itself.
- `INT_TEST_BRANCH_PREFIX` — defaults to `int-test`; only override if multiple users share the same int-test repo.

**Layout** under `tests/integration/scenarios/`:
- `bootstrap/` — A1, A2 (two-step bare-repo bootstrap), C2 (resume firstSyncFromLocal mid-upload). Uses the public ephemeral repo via `bootstrapEnabled()`.
- `sync/` — everything else, branch-per-test on the persistent int-test repo. Series organized by theme:
  - **A3** — first-sync-from-remote into empty vault.
  - **B1–B3** — adoption flows (identical / extras / conflict).
  - **C1** — resume firstSyncFromRemote mid-download.
  - **D1–D3** — incremental upload / download / bidirectional deletes.
  - **E1–E4** — onload reconcile, atomic conflict resolution (binary, plugin-js, plugin-js-same-version), gitignore blocking.
  - **F** — special chars in paths + content edge cases (one file, 7 sub-tests).
  - **G1–G4** — multi-device stress: 3-client rotation, last-write-wins, modify-vs-delete, delete-vs-modify resurrection.
  - **H1–H4** — out-of-band drift: web-UI modify between syncs, updateBranchHead failure recovery, sync race (`syncing` flag), settings-change-mid-sync.
  - **I1–I4** — settings lifecycle: reset, syncConfigDir off/on, deviceName change.
  - **J1–J5** — auth / API failures: token revoked, 429 backoff, wrong owner, missing branch, network drop.
  - **K1–K5** — manifest corruption / recovery: invalid JSON, deleted, future lastSync, unknown fields, empty files map.

**Helpers** (`tests/integration/helpers.ts`) — `createClient`, `writeVaultFile`, `readRemoteFile`, `listRemoteFiles`, `removeRemoteFile`, `writeRemoteFile`, `getBranchHead`, `countBranchCommits`, `syncAndAssertNoErrors`, `syncAndCollectErrors`, plus fault-injection primitives below.

**Fault injection** (`mock-obsidian.ts` `RequestFaultInjector` + helpers):
- `failOnNthMatch(matcher, n, message)` — throws an Error before fetch on the Nth matching call. Used by C1, C2, H2, J5 to simulate kills / network drops.
- `respondForFirstN(matcher, n, fakeResponse)` — short-circuits the first N matching calls with a synthesized HTTP response (status + headers + body). Used by J2 to feed deterministic 429s into retryUntil's loop without actually rate-limiting the live PAT.
- Always reset in `afterEach` via `installRequestFaultInjector(null)` — the injector is global to the vitest worker and would leak between tests otherwise.

### Perf baselines (`tests/perf/`, `pnpm test:perf`)

Opt-in, not in CI. Emits one `PERF_BASELINE {"name":...,"ms":...,...}` line per test; doesn't fail on slow runs (perf is signal, not a gate). The `PERF_BASELINE` prefix is a sentinel for log-scraping. ~1 min total wall-clock against a healthy connection.

Tests:
- **P1** — bulk text upload at 100/250/500 files (parametric `it.each`). Times the incremental sync that ships the bulk via `createTree`'s inline content path.
- **P2** — single 10 MB binary through `createBlob` (~13 MB base64 in the body).
- **P3** — 50 small (~1 KB) deterministic binaries — guard against future serialization of `commitSync`'s `filesToUpload` Promise.all loop. If the loop ever gets serialized, this number jumps roughly 50×.
- **P4** — 245-file A3-style vault: 200 markdown notes + 30 daily-journal entries + 10 PNG attachments + 5 configDir snippets.

`tests/perf/perf-helpers.ts` — `timed(name, extras, fn)` wraps an async block and emits the baseline; `deterministicBytes(seed, length)` generates non-compressible bytes seeded by a string so two runs produce identical SHAs (resume-skip optimization stays consistent across re-runs).

## Constraints to respect

- **Paths** always through `normalizePath` from `obsidian` before touching the adapter.
- **`main.js` at repo root** is the build output Obsidian loads (`manifest.json` points at it). It's not source.
- **Mobile support**: `isDesktopOnly: false` in `manifest.json`. Don't introduce Node-only APIs in `src/`; `benchmark.ts` and `mock-obsidian.ts` are the only Node-side files and aren't bundled.
- **Don't add files to the hardcoded `isSyncable` blocklist** without a real reason. The default for new "should we sync this?" rules is to add patterns to the seeded gitignore (`CONFIG_DIR_SEED` / `ROOT_SEED` in `gitignore-cache.ts`) — that way users can opt out.
- **Don't ship per-device manifest fields to remote**. `commitSync` and the bootstrap/adoption helpers strip `firstSyncFromRemoteInProgress`, `firstSyncFromLocalInProgress`, `pluginCreatedGitignores`, and `preExistingGitignoreShas` from the manifest content before push. They're per-device progress markers / install metadata, not shared state. If you add a new manifest field of this kind, add it to the strip list in all three places (search for `delete manifestForRemote.`).
- **The conflict view UI is fragile** on mobile and long text files. Atomic resolution carries most of the load; if you add new conflict shapes, check whether they belong in the atomic path before plumbing them through the diff modal.
- **`vault.adapter.read` is for text only.** Use `readBinary` for anything `hasTextExtension` says false. Especially important on iOS where the text path silently corrupts binary content.
- **Don't hand-edit the canonical block in `<configDir>/.gitignore`** — `GitignoreCache.initialize()` will rewrite it on the next plugin load. To customise the truly-required behaviour, edit the constants in `gitignore-cache.ts` and ship a new build.
