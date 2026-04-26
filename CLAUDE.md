# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this plugin is

An Obsidian plugin that syncs a local vault with a GitHub repository using **only the GitHub REST API** — no `git` binary, no `isomorphic-git`. This constraint is deliberate so the plugin works identically on desktop and mobile. It means features like branching, merging, rebasing, or any non-GitHub host are out of scope.

This branch (`init-state-machine-refactoring`) sits 10+ commits ahead of upstream main. Significant architectural changes vs upstream: state-machine routing, gitignore-driven filtering, atomic conflict resolution, resume markers, atomic bare-repo bootstrap. See `git log --oneline upstream/main..HEAD` for the chain.

## Commands

Package manager is **pnpm** (CI uses `pnpm@latest-10`).

- `pnpm dev` — esbuild watch mode, emits `main.js` with inline sourcemaps. Set `OBSIDIAN_PLUGIN_DIR` env var to also mirror `main.js` / `manifest.json` / `styles.css` into a vault's plugin folder on every successful build (paths starting with `~/` are expanded). On macOS, IDE-set env vars don't pass through shell expansion — the config does that itself.
- `pnpm build` — typecheck (`tsc -noEmit`) then production bundle. Run before committing; CI runs the same on tag pushes.
- `pnpm test` — vitest, runs once and exits. ~76 unit tests covering pure helpers (isSyncable, classifyForConflict, decideInitAction's full decision table, GitignoreCache helpers, MetadataStore.load() invariants, etc.). Mocks the `obsidian` module via `vitest.config.ts` alias to `mock-obsidian.ts`.
- `pnpm test:watch` — vitest watch mode.
- `pnpm benchmark` — `benchmark.ts`: real `firstSync` against GitHub. Requires env vars `GITHUB_TOKEN`, `REPO_OWNER`, `REPO_NAME`, `REPO_BRANCH` and an SSH-accessible remote (uses `git clone` over SSH to wipe the repo between runs).

Releases are triggered by pushing a tag matching `[0-9].[0-9]+.[0-9]+*` (a `-beta` suffix cuts a prerelease); `version-bump.mjs` syncs `manifest.json` and `versions.json` from `package.json`.

## Architecture

### One entry point, state machine routes the rest

`SyncManager.sync()` is the only public method to call. Inside it:

1. Refresh the gitignore cache if files changed.
2. `dispatchSync()`:
   a. Read resume markers (`firstSyncFromRemoteInProgress`, `firstSyncFromLocalInProgress`).
   b. `analyzeLocalState()` + `analyzeRemoteState()` (in parallel) classify each side as `empty` / `has-manifest` / `has-content-no-manifest` (local) or `bare` / `has-manifest` / `has-content-no-manifest` (remote).
   c. `decideInitAction()` (pure, in `sync-state.ts`) maps the (local, remote, resume) tuple to one of: `regular-sync`, `bootstrap-empty`, `first-sync-from-local`, `first-sync-from-remote`, `needs-adoption-analysis`, `adopt`, `ambiguous`.
   d. For `needs-adoption-analysis`: hash every local syncable file, intersect with remote tree SHAs, partition into identical/local-only/remote-only/conflicting. `shouldAutoAdopt` returns true iff `conflicting.length === 0` → silent adopt + auto-reconcile via regular sync. Otherwise emit `ambiguous`.
   e. For `ambiguous`: fire the `onAmbiguousState` callback (wired to `InitDecisionModal` in main.ts) with the analysis. The user picks "Keep local" / "Keep remote" / "Cancel".
   f. `executeInitAction(action)` calls the matching helper.

The old `settings.firstSync` boolean used to gate routing in main.ts. It now lives only as a backward-compat field — `main.ts:sync()` clears it after the first successful sync but never reads it.

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

`MetadataStore` (`src/metadata-store.ts`) defines `github-sync-metadata.json`. It tracks `{ sha, lastModified, dirty, justDownloaded, deleted, deletedAt }` per file plus per-device flags `firstSyncFromRemoteInProgress` / `firstSyncFromLocalInProgress`. The file is pushed to GitHub as a regular tracked file — that's how a different device discovers what was synced.

Two invariants:

- **`MetadataStore.load()` always inserts an entry for the manifest itself** in `data.files`. Several call sites (most notably `commitSync`) used to crash with TypeError if a hand-edited manifest didn't carry that entry; the invariant pushes the guard down to the only place it makes sense.
- **`commitSync` constructs the manifest tree entry from current in-memory metadata, never reading or mutating a caller-provided slot.** Callers can't forget to populate it, and they can't accidentally pass mismatched contents. The `firstSync*InProgress` flags are stripped from the manifest content before push (per-device, not shared state).

### First-sync paths

- **`bootstrap-empty`** (both sides empty): direct Git Data API path — `createBlob` (manifest) → `createTree` (no `base_tree`) → `createCommit` (no `parent`) → `createReference` (POST `/git/refs`). Atomic from our side: we know the new tree SHA without re-fetching, so the eventual-consistency race we used to have is gone. Returns the freshly-built `RemoteState` so the caller doesn't need to re-analyze.
- **`first-sync-from-remote`** (local empty, remote has content): per-file blob downloads via `getBlob`, batched 5 at a time. Holds at most one blob in memory — Android-friendly. Resumable: the `firstSyncFromRemoteInProgress` marker plus per-file `metadata.sha` SHA matching let an interrupted attempt skip work it already finished.
- **`first-sync-from-local`** (vault has content, remote bare or has-content-no-manifest): mirrors the metadata's view of local files into a tree, then `commitSync` uploads. The `firstSyncFromLocalInProgress` marker is set on entry and cleared on the in-memory copy just before the commit; `commitSync` persists `false` only on success. Resume optimization in `commitSync` skips `createBlob` for any binary whose Git blob SHA matches `metadata.files[path].sha` (content-addressed — match means the previous attempt already pushed it).
- **`adopt`** (both sides have content, no real conflicts): write a manifest reflecting the union of local and remote, push it via Contents API, then run a regular sync. The user sees no prompt.

### Conflict resolution

`findDivergedPaths()` (`sync-manager.ts`) classifies every diverged file into `plugin-js`, `binary`, or `text` (`classifyForConflict` in `utils.ts`). Classification is content-aware: a `.json` file with a 5 MB single-line dump comes back as `binary` because `isMergeFriendlyText` flags it (size > 2 MB or any line > 4 KB or null bytes).

- **plugin-js** (any `.js` inside `<configDir>/plugins/<id>/`): `resolveAtomicConflicts` reads both sides' `manifest.json` versions, compares with `compareSemver`, falls back to `lastModified`, and as a last resort picks local. Optionally drops a `<base>.conflict-(local|remote)-<isoTimestamp>.<ext>` next to the winner (controlled by `keepPluginConflictCopy` setting; off by default).
- **binary** (no text extension OR text-but-not-merge-friendly): timestamp resolution, then local-wins. Always drops a backup of the loser side.
- **text** (everything else): goes through the existing CodeMirror split/unified diff modal in `views/conflicts-resolution/`. Note: this UI is rough on mobile and on long files; the design choice was to keep the modal but route as much as possible to atomic resolution so users rarely see it.

The `*.conflict-(local|remote)-*` pattern is in the seeded root `.gitignore`, so backups stay strictly local by default. Users can opt into syncing them by removing the lines.

### Reconcile on every onload

`SyncManager.reconcileWithVault()` runs from `loadMetadata()` on every plugin start. It walks the vault, marks any tracked-but-missing file as deleted (with `deletedAt`), and adds any on-disk-but-untracked file as a fresh entry. This catches changes that happened off the events listener's watch — disable→edit-vault→re-enable, crash recovery, files restored from backup, drag-and-drop in Finder, etc. Content-level divergence on the same path is still `findDivergedPaths`' job during sync.

### Why binary vs text matters at the wire level

`hasTextExtension` (in `utils.ts`) gates a read path: text files are uploaded via `tree[].content`; anything else is read as a binary `ArrayBuffer`, base64'd, uploaded as a blob, and the tree references the blob SHA. Reading a binary file as text via `vault.adapter.read` fails on iOS — the extension check is the guardrail. **Don't call `adapter.read` on anything `hasTextExtension` returns false for.**

### Logger backstop

`Logger` (`src/logger.ts`) truncates `additional_data` to 64 KB if its serialized form exceeds that. Without this, a chatty callsite logging a full sync action list (tens of thousands of entries) used to balloon `<configDir>/github-sync.log` to hundreds of MB per sync. Targeted summaries at known-large callsites (`Actions to sync`, `Found conflicts`, `Remote manifest is missing`) keep the backstop from kicking in during normal operation.

### GitHub client (`src/github/client.ts`)

Thin wrapper over Obsidian's `requestUrl` (not `fetch` — `requestUrl` avoids CORS and works identically on mobile). Every method takes `retry`/`maxRetries` and uses `retryUntil` with exponential backoff; retries skip on HTTP 422 (unprocessable). Notable:

- `createTree` accepts an optional `base_tree` (omit for first commit on bare repo).
- `createCommit` accepts an optional `parent` (omit for root commit).
- `createReference` (POST `/git/refs`) for publishing the bootstrap branch.

`fetch` and HTTP `Range` requests were both tried for streaming the zipball during firstSync — `fetch` hits a CORS wall on the `codeload.github.com` redirect, `Range` is silently ignored by GitHub's CDN for dynamically-generated archives. Both confirmed dead ends; per-file blob downloads it is.

### Events listener (`src/events-listener.ts`)

Obsidian fires `create`/`modify`/`delete`/`rename` events. The listener calls into `isSyncable` (with the gitignore cache, just like SyncManager) and updates the local manifest (`dirty`, `lastModified`, `deleted`). **`justDownloaded` trick**: when `SyncManager` writes a file during download, Obsidian still fires `create`/`modify`. We pre-mark the entry; the listener sees the flag, clears it, and doesn't re-mark the file as user-modified. Listener registration is deferred to `workspace.onLayoutReady` to avoid the synthetic create flood at startup.

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

`tests/` holds vitest specs (76 cases). Pure helpers covered; SyncManager orchestration and GithubClient network calls are not — those need integration tests that haven't been built yet.

## Constraints to respect

- **Paths** always through `normalizePath` from `obsidian` before touching the adapter.
- **`main.js` at repo root** is the build output Obsidian loads (`manifest.json` points at it). It's not source.
- **Mobile support**: `isDesktopOnly: false` in `manifest.json`. Don't introduce Node-only APIs in `src/`; `benchmark.ts` and `mock-obsidian.ts` are the only Node-side files and aren't bundled.
- **Don't add files to the hardcoded `isSyncable` blocklist** without a real reason. The default for new "should we sync this?" rules is to add patterns to the seeded gitignore (`CONFIG_DIR_SEED` / `ROOT_SEED` in `gitignore-cache.ts`) — that way users can opt out.
- **Don't ship the resume flags to remote**. `commitSync` strips `firstSyncFromRemoteInProgress` and `firstSyncFromLocalInProgress` from the manifest content before push. They're per-device progress markers, not shared state.
- **The conflict view UI is fragile** on mobile and long text files. Atomic resolution carries most of the load; if you add new conflict shapes, check whether they belong in the atomic path before plumbing them through the diff modal.
- **`vault.adapter.read` is for text only.** Use `readBinary` for anything `hasTextExtension` says false. Especially important on iOS where the text path silently corrupts binary content.
- **Don't hand-edit the canonical block in `<configDir>/.gitignore`** — `GitignoreCache.initialize()` will rewrite it on the next plugin load. To customise the truly-required behaviour, edit the constants in `gitignore-cache.ts` and ship a new build.
