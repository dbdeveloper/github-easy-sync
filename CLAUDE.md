# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

1. Don't assume. Don't hide confusion. Surface tradeoffs.
2. Minimum code that solves the problem. Nothing speculative.
3. Touch only what you must. Clean up only your own mess.
4. Define success criteria. Loop until verified.
5. Follow Occam's Razor. Keep your project simple — but don't overcomplicate it. Not sure how? Just ask!

## What this plugin is

An Obsidian plugin that syncs a local vault with a GitHub repository using **only the GitHub REST API** — no `git` binary, no `isomorphic-git`. This constraint is deliberate so the plugin works identically on desktop and on Obsidian Mobile. Branching, rebasing, non-GitHub hosts are out of scope.

## Where to read what

- **User-facing overview, installation, settings reference, conflict-resolution UX, migration from other plugins**: [`README.md`](./README.md).
- **Canonical spec for the whole sync engine** — conflict-resolution layer (sibling files, conflict branches, three-step / five-step atomic protocols, scenarios A–E) AND push pipeline layer (pre-flight validation, pending-deletions queue, push-queue depth signal) AND cross-cutting infrastructure (cross-platform contracts, typed error hierarchy, skip-class discipline): [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md). **Read this first** when working on anything under `src/sync2/`, `src/errors.ts`, the GitHub client (`src/github/client.ts`), or any test that exercises the engine. Code comments cross-reference the article's section numbers (§4.3, §9.4, §10 Scenario E, §11 cross-platform, §12.1 pre-flight validation, §12.2 pending-deletions, §13 error taxonomy, §14 skip-class, §16 field postmortems, etc.).
- **Diff2 widget design** (UI/UX layer on top of pseudo-merge mode; subproject on the `diff2` branch): [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./docs/DIFF2_IMPLEMENTATION_PLAN.md). **Canonical spec for the diff-edit widget**, conflict/history/deleted views (R2.2–R2.4), `TrashStore` (R3), external-tool integration (R6), CM6 unified DiffPane (R7), R7.11 exit protocol with proactive sibling cleanup, and crash resilience (R8). **State**: `main` (2.0.1-beta4) carries no `src/diff2/` code; the `diff2` branch has shipped Phase 9a (TrashStore subsystem — full R3, sync2 carve-out wired). Remaining phases (0–8, 9b, 10–11) and the recommended sequencing are catalogued in §R12. When working on `src/diff2/` (on the branch) or any change that touches the diff-edit widget, read the plan first — and in tandem with [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md), which the plan repeatedly cross-references (§5 Phase A/B, §8 byte-match rule, §9.4/§9.5 staging protocols, §9.7 filesystem-authoritative, §10 Scenarios C/E, §11 cross-platform, §12 push pipeline).

Behaviour described in the article is locked in by the unit + integration suites. If you change anything in the engine and the article disagrees, fix the code OR update the article — don't let them drift.

## Commands

Package manager is **pnpm** (CI uses `pnpm@latest-10`).

- `pnpm dev` — esbuild watch mode, emits `main.js` with inline sourcemaps. Set `OBSIDIAN_PLUGIN_DIR` env var to also mirror `main.js` / `manifest.json` / `styles.css` into a vault's plugin folder on every successful build (paths starting with `~/` are expanded). On macOS, IDE-set env vars don't pass through shell expansion — the config does that itself.
- `pnpm build` — typecheck (`tsc -noEmit`) then production bundle. Run before committing; CI runs the same on tag pushes.
- `pnpm test` — vitest unit suite, runs once and exits (~5 s).
- `pnpm test:watch` — vitest watch mode.
- `pnpm test:integration` — full integration suite against real GitHub (~20 min). Bootstrap suite included.
- `pnpm test:integration:bootstrap` — bootstrap suite only (~3 min).
- `pnpm test:integration:nonbootstrap` — everything except bootstrap (~17 min).
- `pnpm test:perf` — opt-in performance baselines under `tests/perf/`. Not in CI; emits `PERF_BASELINE {…}` lines.
- `pnpm benchmark` — predates the integration suite; requires SSH-accessible remote. Rarely needed; `test:integration` is preferred.

### Releases

Triggered by a pushed tag matching `[0-9].[0-9]+.[0-9]+*`; a `-beta` suffix cuts a prerelease. `npm version <ver>` runs `version-bump.mjs`, which syncs `manifest.json` and `versions.json` from `package.json`.

**`manifest-beta.json` is NOT auto-synced.** When bumping to a `-beta` version, edit it manually to match.

## Module layout (`src/`)

```
src/
├── main.ts                          # Plugin entry; commands, ribbons, IntervalScheduler wiring,
│                                    #  resetPluginState (calls renameVaultSiblingsToUnresolved
│                                    #  before clearAll), pushPluginsDataJsonCached
├── gi.ts                            # GI (gitignore matcher) — path-browserify, mobile-safe
├── logger.ts                        # Truncated JSON log file
├── utils.ts                         # hasTextExtension, retry helpers, calculateGitBlobSHA,
│                                    #  isRetriableStatus / isWriteRetriableStatus / isRetriableError,
│                                    #  describeError (typed-error extractor used by safeStringify)
├── errors.ts                        # SyncError class hierarchy: NetworkError, GithubAPIError +
│                                    #  4 status subclasses, PlatformError, StaleStateError, makeGithubAPIError
│                                    #  dispatcher. PSEUDO-MERGE-MODE §13.
├── github/client.ts                 # Thin requestUrl wrapper, retryUntil; throws via makeGithubAPIError;
│                                    #  getContentsAtRef does Blobs-API fallback for >1MB files (PSEUDO-MERGE-MODE §16.6)
├── settings/
│   ├── settings.ts                  # GitHubSyncSettings + DEFAULT_SETTINGS
│   └── tab.ts                       # Settings UI (trim onChange, Reset modal)
└── sync2/
    ├── sync2-manager.ts             # Orchestrator: syncAll, syncFile, drain, processBatch,
    │                                #  validateDeletionsAgainstHead (pre-flight, §12.1),
    │                                #  finalizeConflictBranchIfReady, synthesizeResolutionSideBatches,
    │                                #  registerConflictAndDropPath, pushConflictPathsToBranch
    ├── interval-scheduler.ts        # Periodic tick + onload startup (testable in isolation)
    ├── change-detector.ts           # Vault walk + findChanges + queue bridge
    ├── push-queue.ts                # .push-queue/ persistence + markers + meta serdes + enqueueSynthetic
    ├── tree-builder.ts              # Batch → tree entries (with uploadedBlobs skip)
    ├── snapshot-store.ts            # github-easy-sync-metadata.json (file name is historic)
    ├── pending-deletions-store.ts   # .pending-deletions/<id>/meta.json — pull-sanitize delete-intents
    │                                #  (PSEUDO-MERGE-MODE §12.2)
    ├── cross-platform.ts            # Centralized contracts: sanitizeFilename (12 forbidden ASCII →
    │                                #  Unicode), encodePathForGithub, safeRename. PSEUDO-MERGE-MODE §11.
    ├── gitignore-invariants.ts      # Invariant .gitignore blocks; always-write enforce
    ├── commit-message.ts            # Hardcoded format* helpers; commitMessageForBatch
    ├── atomic-write.ts              # 5-step atomicWriteFile + stagingPathFor + AtomicWriteRecovery.sweep
    ├── conflict-store.ts            # ConflictRecord + 3-step create + renameVaultSiblingsToUnresolved
    ├── conflict-classifier.ts       # Pure classify() + evaluateConflictState (Phase A + Phase B)
    ├── conflict-watcher.ts          # vault.on listener; READ-ONLY counter.markDirty()
    ├── conflict-counter.ts          # UI count formula + debounced recompute + subscribe
    ├── conflict-branch.ts           # buildConflictBranchName + CONFLICT_BRANCH_PREFIX
    ├── conflict-detection.ts        # attemptAutoMerge dispatch + classifyConflictKind
    ├── plugin-js.ts                 # isAtomicPluginFile, compareSemver, readPluginVersion
    ├── three-way-merge.ts           # mergeText (diff3-style)
    ├── text-normalize.ts            # CRLF→LF, BOM strip, trailing-NL
    ├── types.ts                     # QueueBatch, FileChange, EnqueueMeta
    └── views/
        ├── conflict-status-indicator.ts   # Status-bar 🔀 count
        └── pre-sync-conflict-modal.ts     # Pre-Sync confirmation modal
```

`src/diff2/` does not exist on `main` (2.0.1-beta4). On the `diff2` branch, Phase 9a is shipped: `src/diff2/{trash-store, trash-watcher, trash-recovery, trash-disk-helpers, strip-conflict-suffix, types}.ts` (data layer + onload recovery for the trash subsystem — see [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./docs/DIFF2_IMPLEMENTATION_PLAN.md) §R3.8–R3.12). Sync2-owned cross-edges added on the branch live at `src/sync2/{trash-hooks, timestamp-id}.ts`; `Sync2Manager` accepts an optional `trashHooks` (last param). DiffPane, conflict/history/deleted views, and the rest of R7 still TBD per §R12 sequencing. When implementing diff2 modules, they consume `src/sync2/` (read `ConflictStore`, subscribe to `ConflictCounter`, use sync2 utils) but `src/sync2/` must not import from `src/diff2/` — see the dependency-direction rule in *Constraints to respect* below.

## Testing

Three independent suites — each in its own directory, own vitest config, own `pnpm` script. All run against the same `mock-obsidian.ts` alias (fs-backed vault stand-in); integration + perf hit the real GitHub API on top of that.

| Suite | Scope | Network | Command | Wall-clock |
|---|---|---|---|---|
| Unit | Pure helpers, store/queue/classifier invariants, orchestrator under a fake client | No | `pnpm test` | ~5 s |
| Integration | `Sync2Manager` end-to-end against real GitHub | Yes | `pnpm test:integration` | ~20 min full |
| Perf baselines | Wall-clock signal on real GitHub upload paths | Yes | `pnpm test:perf` | ~1 min |

`pnpm build` runs `tsc -noEmit` before bundling — keep it green.

### Integration env (`.env.test` at repo root)

- `GITHUB_TOKEN` — fine-grained PAT on the persistent int-test repo. Permissions: Contents R/W, Metadata R. Cannot create or delete repos — leak blast radius is one repo's contents.
- `INT_TEST_OWNER` / `INT_TEST_REPO` — that private int-test repo. Tests use branch-per-test (`int-test-<scenario>-<timestamp>-<n>`), deleted in `afterEach`. Default branch is bootstrapped lazily on first run via `ensureRepoNotBare`.
- `GITHUB_BOOTSTRAP_TOKEN` — classic PAT with `public_repo` + `delete_repo`. Only for the bootstrap suite, which must delete+recreate to regain bare state. The two-token split exists because fine-grained PATs can't create repos.
- `INT_BOOTSTRAP_TEST_REPO` — public ephemeral repo the bootstrap suite recreates. Dropped at end of run via `tests/integration/teardown.ts`.
- `INT_TEST_BRANCH_PREFIX` — defaults to `int-test`; override if multiple users share the same int-test repo.

### Test layout (`tests/integration/scenarios/sync2/`)

```
sync2/
├── bootstrap/             # A-series: bare-repo bootstrap (uses BOOTSTRAP_TOKEN)
├── adoption/              # B-series: first sync against non-bare remote
├── normalization/         # C-series: CRLF/BOM round-trips, resume strategies
├── incremental/           # D-series: post-adoption incremental flows
├── conflicts-misc/        # E-series: reconcile-onload, binary, plugin-js semver/mtime
├── edges/                 # F: special chars in paths + content edge cases
├── multi-device/          # G-series: rotation, multi-device conflicts
├── drift/                 # H-series: out-of-band drift, transient PATCH retry
├── settings-lifecycle/    # I-series: reset, syncConfigDir toggle, deviceLabel change, repo switch
├── api-failures/          # J-series: 401/429/404/network drop
├── manifest-corruption/   # K-series: corrupted snapshot manifest scenarios
├── accumulate/            # L-series: accumulate semantics + .attempted marker
├── conflicts/             # Pseudo-merge end-to-end (branch lifecycle, edit-while-in-conflict, etc.)
├── rename/                # gitignore + rename interaction
└── empty-progression.test.ts
```

Tests use **branch-per-test** on the persistent private int-test repo. Bootstrap is the exception — it needs delete+recreate, so uses the public ephemeral repo.

On the `diff2` branch, additional buckets exist: `tests/diff2/` (unit + crash-resilience for the trash subsystem) and `tests/integration/scenarios/diff2/n-series-trash/` (end-to-end against real GitHub). They run automatically under `pnpm test` / `pnpm test:integration`.

### Single-spec runs

```
pnpm vitest run tests/sync2/conflict-store.test.ts
pnpm vitest run --config vitest.integration.config.ts tests/integration/scenarios/sync2/conflicts
```

The bucket form takes a glob — `tests/integration/scenarios/sync2/conflicts*` matches both `conflicts/` and `conflicts-misc/`.

### Sync2-specific test helpers

`tests/integration/scenarios/sync2/helpers.ts`: `createSync2Client`, `Sync2TestClient`, `sync2AllAndAssertNoErrors`, `sync2FileAndAssertNoErrors`. The client owns its vault temp dir by default; pass `ownsVaultPath: false` (first instance) + `ownsVaultPath: true` (second) to share a vault across two test "sessions". Pass `autoCanonicalize: true` to opt into canonicalize for tests that exercise that codepath (helper default is `true` for back-compat with the C-series; production default is `false`).

### Fault injection

`tests/integration/helpers.ts` exports the test-side wrappers; `mock-obsidian.ts` carries the `RequestFaultInjector` itself:

- `failOnNthMatch(matcher, n, message)` — throws on the Nth matching request.
- `respondForFirstN(matcher, n, fakeResponse)` — short-circuits the first N matching requests with a synthesized HTTP response (exercises retry logic without rate-limiting the live PAT).

**Always reset in `afterEach`** via `installRequestFaultInjector(null)` — the injector is global to the vitest worker and would leak between tests otherwise.

### MOCK_PLATFORM-paired tests

`tests/mock-obsidian-platform.test.ts` parametrises a `describe.each([{platform: "desktop"}, {platform: "mobile"}])` so the same body runs under both POSIX rename semantics (overwrites silently) and Capacitor rename semantics (throws on existing destination). Use this pattern for any new test touching `adapter.rename` so a Capacitor-only regression cannot slip through.

## Constraints to respect

- **Paths** always through `normalizePath` from `obsidian` before touching the adapter.
- **`main.js` at repo root** is the build output Obsidian loads (`manifest.json` points at it). It's not source.
- **Mobile support** — `isDesktopOnly: false` in `manifest.json`. Don't introduce Node-only APIs in `src/`; `benchmark.ts` and `mock-obsidian.ts` are the only Node-side files and aren't bundled. A top-level `import * as fs from "fs"` (or `path`, `os`, `crypto`, etc.) leaves a `require("fs")` at the top of the bundle (esbuild marks these external by default) and **throws on Obsidian Mobile at module load** — there is no Node runtime in the Capacitor WebView — silently crashing the plugin during "Enable" in the community-plugins list. Two valid patterns:
  - (a) use a pure-JS polyfill (`src/gi.ts` uses `path-browserify`; remove the polyfill's name from the esbuild `external` list so it gets bundled instead of `require`'d);
  - (b) wrap the `require` inside a function body with `try/catch` so it's never evaluated at module load — see `defaultReadFile` in `src/gi.ts` for the fs case (only test-time code path; production injects a vault-adapter reader instead).

  To verify, grep the production bundle: `grep -E "=require\\(\\\"fs\\\"\\)|=require\\(\\\"path\\\"\\)" main.js` must return zero matches at file scope.
- **Capacitor `rename` does not overwrite.** On iOS / Android the vault adapter's `rename` throws "Destination file already exists" when the target is occupied. POSIX `rename` overwrites silently. The portable pattern is `if (exists(dst)) await remove(dst); await rename(src, dst);`. `src/sync2/atomic-write.ts` and `src/sync2/conflict-store.ts` already follow it. Any new write-then-rename path must too — pair it with a `MOCK_PLATFORM=mobile` test.
- **Settings-tab text inputs must trim user input.** Android keyboards (and several third-party iOS ones) reliably append trailing whitespace to paste operations from the suggestion bar. A token like `ghp_abc123 ` (one trailing space) makes every GitHub REST call return 404 with valid permission headers — GitHub masks "valid token, repo outside scope" as 404 to avoid leaking private-repo existence, and a whitespaced token never matches the configured repo's scope. `src/settings/tab.ts` calls `.trim()` in every `onChange` for token/owner/repo/branch, and `src/main.ts:loadSettings` runs a one-pass sanitize on read so existing installs with whitespace-poisoned values self-heal on plugin restart.
- **`vault.adapter.read` is for text only.** Use `readBinary` for anything `hasTextExtension` says false. Especially important on iOS, where the text path silently corrupts binary content.
- **Don't add files to the hardcoded `isSyncable` blocklist** without a real reason. The default for new "should we sync this?" rules is to add patterns to the seeded gitignore (`CONFIG_DIR_SEED` / `ROOT_SEED` in `gitignore-invariants.ts`) — that way users can opt out.
- **Don't hand-edit the canonical block in `<configDir>/.gitignore`** — `GitignoreInvariants.enforce()` will rewrite it on the next plugin load. To customise the truly-required behaviour, edit the constants in `gitignore-invariants.ts` and ship a new build.
- **Polling, not events, for the sync engine.** `findChanges` walks the vault on each sync click; no `vault.on` subscription for sync purposes. Implication: edits made while the plugin was disabled get picked up on the next sync click without any "missed events" failure mode. The conflict layer's `ConflictWatcher` IS event-driven (`vault.on('delete'|'modify'|'rename')`), but **read-only** — it only calls `counter.markDirty()`, never mutates store; all conflict mutations happen at drain-start. See [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md) §5.
- **No scheduler logic in `main.ts`.** Periodic-tick decisions (interval enabled vs watchdog vs `autoCommitOnSync`) and the onload-startup pulse live in `src/sync2/interval-scheduler.ts` so they can be unit-tested in isolation under a fake timer. If you find yourself adding an `setInterval` or `app.workspace.onLayoutReady` callback for sync purposes inside `main.ts`, move it into `IntervalScheduler` instead.
- **`drain()` is re-entrant-safe via a `running` flag** on `Sync2Manager`. Concurrent `syncAll()` calls (e.g. interval tick fires while user click is mid-flight) collapse into one drain — the second call returns immediately. Don't bypass this with a separate code path; the integration suite's H3 test pins the serialisation.
- **Commit messages are hardcoded** in `src/sync2/commit-message.ts` (`formatSyncMessage`, `formatResolveConflictMessage`, etc.). Don't reintroduce a per-user template field — the design choice was deliberate (date/time live in commit metadata; provenance lives in the trailing `(deviceLabel)` suffix).
- **When working on conflict resolution OR the push pipeline OR cross-cutting infrastructure** (cross-platform contracts in `cross-platform.ts`, typed errors in `errors.ts`, pending-deletions in `pending-deletions-store.ts`, skip-class annotations in any loop), [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md) is the canonical spec the code targets. Code comments reference the article's section numbers (e.g. `§9.4`, `§10 Scenario E`, `§11 cross-platform contracts`, `§12.1 pre-flight validation`, `§13 error taxonomy`, `§14 skip-class`); use those to navigate between code and design rationale. The bug catalog in `§16 Field Postmortems` is the triage index for similar future symptoms.
- **When working on `src/diff2/`**, [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./docs/DIFF2_IMPLEMENTATION_PLAN.md) is the canonical spec. Diff2 is **purely additive UI/UX on top of pseudo-merge mode**: it must not change `ConflictStore` semantics, never bypass Phase A/B at drain start, and never push commits / mutate the conflict branch directly (that's `sync2-manager`'s job). The two operations diff2 may perform on the vault are (a) write base-file bytes through `atomicWriteFile`, and (b) `adapter.remove(siblingPath)` as the R7.11 proactive-cleanup step when `SHA(base) == SHA(sibling)`. Everything else is a `sync2/` concern that diff2 only observes.
- **Diff2 → sync2 dependency direction.** When `src/diff2/` modules start landing, they may import from `src/sync2/` (read `ConflictStore`, subscribe to `ConflictCounter`, observe `Sync2Manager` events). But **`src/sync2/` must never import from `src/diff2/`**. This keeps the sync engine buildable and testable without the UI layer (e.g., for sync-only regression runs and for the existing integration suite), and preserves the option to ship `src/diff2/` as a separate plugin later. Any new edge in `src/sync2/*.ts` that imports `../diff2/...` is a regression — surface it instead of bridging.
