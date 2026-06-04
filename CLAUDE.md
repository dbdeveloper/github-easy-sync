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
- **Per-release notes** (Keep-a-Changelog format): [`CHANGELOG.md`](./CHANGELOG.md). README links here for "What's new"; do NOT add per-release notes back into README. New release → add a section to `CHANGELOG.md` and bump the version in `package.json` + `manifest.json` + `manifest-beta.json` + `versions.json`.
- **Canonical spec for the conflict-resolution ALGORITHM** — the abstract pseudo-merge model: sibling files, per-device conflict branches, the three kinds of conflict, auto-merge strategies, editing-while-in-conflict, full scenario walk-throughs (A–E), and what the algorithm deliberately does NOT promise: [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md). Read this to understand *what* pseudo-merge does and *why*, independent of implementation. Section numbers: §1–4 (problem + git model + core idea), §5 (three kinds of conflict), §6 (auto-merge strategies), §7 (editing while in conflict), §8 (scenarios A–E), §9 (non-promises), §10 (glossary).
- **Canonical spec for the sync ENGINE** — how the algorithm is realised on top of the GitHub REST API: architecture layers, crash-recovery protocols (three-step / five-step atomic writes, recovery sweep, tail re-check), cross-platform contracts, push pipeline (pre-flight validation, pending-deletions queue, push-queue depth signal), typed error hierarchy, skip-class discipline, Worker orchestra, SHA-first reconcile, modify-in-place, plugin reload, self-update marker protocol: [`docs/SYNC2.md`](./docs/SYNC2.md). **Read this first** when working on anything under `src/sync2/`, `src/errors.ts`, `src/worker/`, the GitHub client (`src/github/client.ts`), or any test that exercises the engine. Code comments cross-reference its section numbers (`SYNC2 §1` architecture, `§2.4`/`§2.5` staging + recovery, `§2.8` tail re-check, `§3` cross-platform, `§4.1` pre-flight, `§4.2` pending-deletions, `§5` error taxonomy, `§6` skip-class, `§7` field postmortems, `§8` worker orchestra, `§9` SHA-first, `§10` modify-in-place, `§11` plugin reload, `§12` self-update marker). When a SYNC2 mechanism realises an algorithmic guarantee, SYNC2.md cites PSEUDO-MERGE-MODE.md back.
- **Diff2 widget design** (UI/UX layer on top of pseudo-merge mode; subproject on the `diff2` branch): [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./docs/DIFF2_IMPLEMENTATION_PLAN.md). **Canonical spec for the diff-edit widget**, conflict/history/deleted views (R2.2–R2.4), `TrashStore` (R3), external-tool integration (R6), CM6 unified DiffPane (R7), R7.11 exit protocol with proactive sibling cleanup, and crash resilience (R8). **Canonical detailed spec** for the autosave / exit-protocol / DiffPane layer is [`docs/tasks/DIFF-EDITOR.md`](./docs/tasks/DIFF-EDITOR.md) (§1–§8: unified DiffPane, **append-log REDO autosave** — `history.jsonl` + snapshots + `cursor.json` + `meta.json`, the **7-step pair-atomic `[←]` commit** with a `done.json` barrier + 11-state recovery matrix). The plan (DIFF2_IMPLEMENTATION_PLAN.md) cross-references it 27×. **State (retrofit in progress, updated 2026-06-04): §1-model-first retrofit on the `diff2` branch; Phase-6 wiring W1 (live `[←]` 7-step commit + onload recovery) DONE.** `main` (2.0.1-beta4) carries no `src/diff2/` code. The shipped subset's DiffPane used a `diff-chunks` side-field that desynced on free edits, so the §5.0 7-step commit's `split(editorDoc)` was unsound — therefore the canonical §1 `\0`/`\1` joined-document model is a **prerequisite, not an option** (this corrects the earlier "retrofit exit-protocol to 7-step first" plan; that would have split garbage). Retrofit sequencing — **Stage 1 (§1 model):** 1a `joined-doc.ts` build/split + `\0`/`\1` collision fail-closed (**DONE**); 1b.0 `editor-model.ts` — clean CM6 doc + ordered `Segment[]` structure mapped through every transaction (**DONE**); 1b.1 DiffPane swap onto editor-model + structure-based render + sibling-wins gutter + chunk-actions as doc-edits + sentinel `transactionFilter`; dead `diff-chunks` model deleted (**DONE**). 1b.3 selection rules §1.7, 1b.4a empty-ver activation §1.8.a, 1b.4b keyboard stop-on-empty-ver arrow nav §1.8 (moveVertically-delegated), 1b.5 auto-collapse §1.6, 1b.6a newline glyph §1.6.a.1, 1b.6b focus-leave + apply-time normalization §1.6.a.2, 1b.7 hotkeys §1.9 (all **DONE**) — **Stage 1 COMPLETE** (§1.1–§1.10, no deferrals). **Stage 1.h + 1.t** (deep-review hardening + exhaustive edge-probing, all TDD): fixed real bugs the per-feature tests missed — auto-collapse coordinate crash (`[tr,spec]` resolved in original-coords → `tr.changes.compose`), boundary-insert drop (`growSegmentIndex`/`growIndexFor` grow the caret's segment), over-applied normalization (now ver-only + resolved-item only). Added commit-boundary **fail-closed** (tiling assert in `fromEditorModel`) + §1.6.a.2 commit-boundary normalization, empty→`\n` (avoids SYNC2 §2.9 zero-byte-restore), `defaultKeymap`+`history`+undo/redo with `structureHistory` (`invertedEffects` versions the structure field across undo). Coverage: long-line/large-doc + 250-step fuzz, selection-shapes, sentinel-guard, Ctrl+A, boundary empty-vers, undo/redo. **Revised sequencing (chicken-and-egg — the 7-step commit needs the autosave dir):** **Stage 2.0** autosave-dir foundation — **DONE 2026-06-02** (`src/diff2/autosave-store.ts`: `deriveAutosaveId` §2.4.1 + `fnv1a64` lane-based 64-bit [ES6 target ⇒ no BigInt literals; pinned to published FNV vectors] + session-start protocol §2.5.a [snapshots + `meta.json` written LAST + dir, via `atomicWriteFile`+`calculateGitBlobSHA`] + `classifyOpen` §2.5.b detection-only `fresh|reuse|mismatch`; greenfield, NOT wired into main.js; tests: `autosave-id` 12 / `autosave-session-start` 9 / `crash-resilience/autosave-session-start-crash` 6 [per-step meta-last invariant]) → **Stage 2.1** 7-step pair-atomic `[←]` commit — **DONE 2026-06-02** (`src/diff2/exit-commit.ts`: `commit7Step` §5.0 [`done.json` barrier hashing the exact staged bytes; SEQUENTIAL step-4/5 renames §5.0.b E/F & H/I; step-6.5 sibling-cleanup gated on `target===meta.siblingPath`; `targetBasePath/Path` default=meta so new-file & save-to-alt unify] + `classifyToctou` §5.0 Step-1.5 detection-only + `recoverCommit` §5.0.a/b as a **pure disk-state function**: SHA-classify each side's final/tmp/bak → 3-way dispatch forward[D–K]/fallback[foreign]/rollback[A–C] — the A–K matrix realised as one dispatch that provably reproduces each row's action; **WIRED into the view as of Phase-6 W1 (2026-06-04)** — `commit7Step` is the live `[←]` save, `recoverCommit` runs at onload (`onload-recovery.ts`); §5.0.e symmetric TOCTOU **WIRED (W5, 2026-06-04)** — `commitUnchangedSide`/`commitToAlt`/`SaveToAltModal` (save-to-alt is plain `atomicWriteFile`, NOT commit7Step — recoverCommit can't roll alt-paths forward); remaining polish = Step-0/8; naive `exit-protocol.ts` DELETED; guarantee is **commit-atomic** [crash ⇒ both sides or neither], NOT yet editing-crash-safe [needs Stage-3 `history.jsonl`]; tests: `exit-commit` 8 / `crash-resilience/exit-commit-recovery-matrix` 17) **and** **Stage 3** live autosave (REDO-log `history.jsonl` §2.6–§2.8 + cursor-timer §2.9 + recovery dialog §3 + cleanup §4) — 2.1 & 3 both build on 2.0, order between them free. **Stage 3 DONE (2026-06-02)** — tested cores (real timers / modals / onload-trigger = Phase 6/11): gate-spike → **format B** (structure in every `history.jsonl` block; §2.6 reconciled); **3a** `history-log.ts` (`fnv1a32` + `{seq,at,change,structure,sum}` + `HistoryWriter` + `replayDispatch`); **3b-1** `joinedDocSha` meta-migration (dropped `joinAlgoVersion`) + `classifyReopen` §3.1 (`resume|library-drift|vault-changed|corrupt|sentinel|fresh`, single-read invariant); **3b-2** `history-replay.ts` (`scanHistory`/`assessHistory`/`replayHistory` §3.3/§3.5, **undo-after-replay** proven via «replay N→undo k == replay N−k»); **3b-3** `cursor-store.ts` (persist/read/clamp §2.9); **3c** `autosave-cleanup.ts` (§4.2 `classifySweep` 7-cond + done.json→defer + `sweepAll` idempotent). Stress test (100KB/20-group, replay==live + split-correctness). **Stage-1.x DONE** — §1.7 Variant-3 spanning free-edit resolve (§1.7.a(0)) FIXED: `detectSpanningResolve`/`rebuildSpanningResolve` branch in collapseGuard (before generic mapStructure) + `assertTiling` exported into the internal collapse path. `save-reopen-stability` test proves the saved files reopen byte-identical (the `build∘split≠identity` on the internal joined string is benign — by §1.5 both representations split to the same files; files never contain `\0`/`\1`). Manual/Playwright coverage (layout, mobile, end-to-end UI — not in autotests) → [`docs/MANUAL-TEST-CHECKLIST.md`](./docs/MANUAL-TEST-CHECKLIST.md). Ratified decisions: `diff` stays v9 (use DEFAULT `diffLines`, not `newlineIsToken`); line-wrap always-on ⇒ `↵` glyph on every line (§1.6.a); sibling-wins single-column line numbers (§1.10). **PLANNED (Stage 3+, decided 2026-06-02): drop `joinAlgoVersion`/`joinAlgoOptions` from `meta.json`; replace with `joinedDocSha` = `SHA(build(base,sibling))` — replay is valid iff that fingerprint reproduces, which detects library-drift DIRECTLY (no version tracking). Implement as part of 3b; do NOT code a `joinAlgoVersion` branch. See DIFF-EDITOR.md §2.5 reconciliation note.** The §R9.1 phase table describes the canonical (elaborate) phasing, NOT the shipped subset — do not read it as "done". When working on `src/diff2/` (on the branch) or any change that touches the diff-edit widget, read the plan first — and in tandem with [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md) (algorithm) and [`docs/SYNC2.md`](./docs/SYNC2.md) (engine), which the plan cross-references for Phase A/B, the byte-match rule, staging protocols, filesystem-authoritative resolution, scenarios, cross-platform contracts, and the push pipeline.

Behaviour described in these two specs is locked in by the unit + integration suites. If you change anything in the engine and a spec disagrees, fix the code OR update the spec — don't let them drift. Algorithm changes land in PSEUDO-MERGE-MODE.md; implementation changes land in SYNC2.md.

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
├── token-expired-flag.ts            # E1 (TODO §5): persistent .token_expired marker
│                                    #  (in-memory authoritative + file mirror) + classifyAuthOutcome
├── status-bar-model.ts              # E2 (TODO §6-7): pure statusBarSuffix +
│                                    #  statusMenuState + buildStatusMenu (status-bar text + menu)
├── utils.ts                         # hasTextExtension, retry helpers, calculateGitBlobSHA,
│                                    #  isRetriableStatus / isWriteRetriableStatus / isRetriableError,
│                                    #  describeError (typed-error extractor used by safeStringify)
├── errors.ts                        # SyncError class hierarchy: NetworkError, GithubAPIError +
│                                    #  4 status subclasses, PlatformError, StaleStateError, makeGithubAPIError
│                                    #  dispatcher. SYNC2 §5.
├── github/client.ts                 # Thin requestUrl wrapper, retryUntil; throws via makeGithubAPIError;
│                                    #  getContentsAtRef does Blobs-API fallback for >1MB files (SYNC2 §7.6);
│                                    #  every HTTP call routes through WorkerClient.httpRequest when one is wired
├── settings/
│   ├── settings.ts                  # GitHubSyncSettings + DEFAULT_SETTINGS (syncStartsWithCommit,
│   │                                #  showCommitRibbonButton, consolidateCommits, maxAutoMergeSizeBytes)
│   └── tab.ts                       # Settings UI (trim onChange, Reset modal, GitHub sync status section,
│                                    #  Performance group with max-auto-merge KB input)
├── worker/                          # Web Worker orchestra (SYNC2 §8). esbuild emits each entry
│   ├── types.ts                     #  point as an IIFE, inlines as string via `define`, runtime wraps in Blob URL.
│   ├── cpu-worker.ts                # CPU pool: decode-base64, compute-git-blob-sha, merge-text (bundles node-diff3)
│   ├── network-worker.ts            # Single dedicated thread; native fetch executor for every GitHub HTTP call
│   └── worker-client.ts             # Main-thread controller; pool dispatch, request-id multiplex, terminate, fallback
└── sync2/
    ├── sync2-manager.ts             # Orchestrator: syncAll, syncFile, drain, processBatch,
    │                                #  validateDeletionsAgainstHead (pre-flight, SYNC2 §4.1),
    │                                #  finalizeConflictBranchIfReady, synthesizeResolutionSideBatches,
    │                                #  registerConflictAndDropPath, pushConflictPathsToBranch
    ├── interval-scheduler.ts        # Periodic tick + onload startup (testable in isolation)
    ├── change-detector.ts           # Vault walk + findChanges + queue bridge
    ├── push-queue.ts                # .push-queue/ persistence + markers + meta serdes + enqueueSynthetic
    ├── tree-builder.ts              # Batch → tree entries (with uploadedBlobs skip)
    ├── snapshot-store.ts            # github-easy-sync-metadata.json (file name is historic)
    ├── pending-deletions-store.ts   # .pending-deletions/<id>/meta.json — pull-sanitize delete-intents
    │                                #  (SYNC2 §4.2)
    ├── cross-platform.ts            # Centralized contracts: sanitizeFilename (12 forbidden ASCII →
    │                                #  Unicode), encodePathForGithub, safeRename. SYNC2 §3.
    ├── gitignore-invariants.ts      # Invariant .gitignore blocks; always-write enforce
    ├── commit-message.ts            # Hardcoded format* helpers; commitMessageForBatch
    ├── atomic-write.ts              # 5-step atomicWriteFile + stagingPathFor + AtomicWriteRecovery.sweep;
    │                                #  fast-path uses vault.modifyBinary for open TFiles (preserves editor cursor/scroll)
    │                                #  via a .sync-tmp + .<basename>.sync-tmp. marker forward-recovery protocol
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
        ├── pre-sync-conflict-modal.ts     # Pre-Sync confirmation modal
        └── token-expired-modal.ts         # 401 / 403 recovery dialog (Stage 7)
```

`src/diff2/` does not exist on `main` (2.0.1-beta4). On the `diff2` branch the **canonical §1-model-first retrofit is in progress** (see the *Diff2 widget design* state note in *Where to read what* above for the full Stage 1a/1b/2/3 sequencing + ratified decisions). The trash subsystem (9a): `src/diff2/{trash-store, trash-watcher, trash-recovery, trash-disk-helpers, strip-conflict-suffix, types}.ts` (data layer + onload recovery — see [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./docs/DIFF2_IMPLEMENTATION_PLAN.md) §R3.8–R3.12). The diff-edit widget: `src/diff2/{diff-edit-view, events, conflicts-list, synthetic-detector, joined-doc, editor-model, diff-pane, decorations, markers, word-level-diff, line-numbers, chunk-actions, conflict-merge-all, toolbar-conflicts, autosave-store, exit-commit, onload-recovery, history-log, history-replay, cursor-store, cursor-timer, autosave-cleanup}.ts`. `autosave-store.ts` (Stage 2.0) is the autosave-dir foundation: `fnv1a64`/`deriveAutosaveId`/`trackedAutosaveId` (deterministic conflict-id §2.4), `startSession` (§2.5.a session-start, `meta.json` last), `classifyOpen` (§2.5.b reopen detection) — consumed by the Stage 2.1 commit + Stage 3 autosave. `exit-commit.ts` (Stage 2.1) is the `[← back]` commit core: `commit7Step` (§5.0 7-step pair-atomic, `done.json` barrier), `classifyToctou` (§5.0 Step-1.5 detection), `recoverCommit` (§5.0.a/b A–K recovery as a pure disk-state dispatch) — **WIRED (Phase-6 W1, 2026-06-04)**: `commit7Step` is the live `[←]` save, `recoverCommit` runs at onload via `onload-recovery.ts`. Model layer = `joined-doc.ts` (`\0`/`\1` build/split + collision) + `editor-model.ts` (clean CM6 doc ↔ ordered `Segment[]` structure, mapped through every transaction); `diff-pane.ts` is the CM6 DiffPane over that model (structure-based decorations, sibling-wins `line-numbers.ts` gutter, free editing, per-group chunk-actions, sentinel `transactionFilter`). `chunk-actions.ts` = `ChunkChoice`/`JoinContext` types only; `conflict-merge-all.ts` = `isMarkdownPath` only (the old `diff-chunks.ts` line-array model was deleted in 1b.1). The `[←]` save is **wired to the 7-step `commit7Step` as of Phase-6 W1 (2026-06-04)**: `DiffEditView.exitDetailView` runs `classifyToctou`→`commit7Step` (or the §5.0.e symmetric TOCTOU path `resolveToctouExit` on mismatch), `mountDiffPane` runs `startSession` (autosave id via `autosaveIdForEntry` — tracked→`record.id` / synthetic→`deriveAutosaveId`), and `recoverCommit` runs at onload via `onload-recovery.ts` (`recoverAutosaveDirs`, BEFORE `AtomicWriteRecovery.sweep` — shared `.sync-{tmp,bak}` suffixes). The naïve `exit-protocol.ts` was **deleted**. Sync2-owned cross-edges added on the branch live at `src/sync2/{trash-hooks, timestamp-id}.ts`; `Sync2Manager` accepts an optional `trashHooks` (last param). **Still TBD** per §R12 sequencing: **Phase-6 wiring W1 + W4 + W2 + W5 + W3 + Step-0/Step-8 DONE** (W1: startSession-at-mount + `commit7Step` `[←]` swap + onload `recoverCommit`; W4: `classifyReopen`→pure `reopenAction` dispatch + `ResumeRecoveryModal` + **symmetric §3.2.a** recovery — a one-side-vault-changed reopen reuses the §3.2 modal with a `*` on the changed file and on Continue writes the restored content of the UNCHANGED side onto the new version + recreates the session, both-sides-changed = silent fresh, `SnapshotMismatchModal` deleted; W2: per-transaction history-feed via a `DiffPane` `EditorView.updateListener` → serialized `HistoryWriter` → `history.jsonl`, so recovery-replay is now LIVE; W5: §5.0.e symmetric `[←]` exit-TOCTOU — `resolveToctouExit` dispatches `commitUnchangedSide` (exactly one side changed → silent single-side write to the UNCHANGED side + log, conflict continues) vs `SaveToAltModal`+`commitToAlt` (both changed → fresh name, converged→1 file / partial→base+derived sibling, **fail-closed** on a colliding name since the prefill IS the changed original; plain `atomicWriteFile`, NOT commit7Step — recoverCommit classifies by meta-paths so an alt-path commit can't roll forward); force-overwrite removed); W5 done; W3: §2.9 cursor 2-slot ping-pong — `cursor-store.ts` reads both slots → writes the stale (lower-seq) one (plain write; the max-seq slot is the never-overwritten recovery fallback), `readCursor` = max valid seq; `startSession` seeds `cursor-a` seq0, `classifySweep` cond-3 = a OR b; `cursor-timer.ts` `CursorScheduler` throttle (2500 typing / 6000 nav) fed by `DiffPane.onSelectionChange` (nav) + `onRecord` (typing); `DiffEditView` stops the timer as the FIRST line of `exitDetailView` (before any commit await); Step-0 ✅ (`committing` re-entrancy guard in `exitDetailView`, try/finally-reset — rejects a second `[←]` mid-commit) + Step-8 ✅ (return detail→list; CM6 history cleared by `view.destroy()` on dispose — there is no `historyClear` API and the view is torn down anyway; §5.0 Step-8 doc corrected). Phase-6 WIRING COMPLETE. **Entry-points** sequenced E1–E6 (R2.7.6): **E1 ✅ DONE (2026-06-05)** — `src/token-expired-flag.ts` `.token_expired` marker (in-memory authoritative + best-effort file mirror, gitignored via `plugins/*/*`; `note(err)` per-drain via pure `classifyAuthOutcome`, wired at the 4 authed entry-points + settings probe; NOT in the throttled `maybeShowTokenExpiredModal`; `isExpiredCached()` for the §7 menu). **E2 ✅ DONE (2026-06-05)** — pure `src/status-bar-model.ts` (`statusBarSuffix` + `statusMenuState` + `buildStatusMenu`, `CONFLICT_GLYPH="⁇"`); `updateStatusBarItem()` parameterless text `GitHub (↑ N | M ⁇)` (no spinner — word+brackets green under drain via `-syncing` on el, `↑ N` decreases live; conflict count folded in, `conflictStatusIndicator` + dead `openFirstSibling` deleted); clickable → `new Menu()` (first in project) 3 states → existing commands (`sync(true)` = always commit+drain for "Sync All"). Remaining: E3 diff-ribbon+tooltips (§8–§9) / E5 deep-link / E4 file-menu / E6 post-sync modal; then entry-points (file-menu, diff ribbon icon, post-sync modal), Phase 7 (History mode), Phase 8 (Compare mode), Phase 9b (Deleted-mode UI + restore), Phase 10 (external diff tool), Phase 11 (onload-recovery-sweep unification). History/Compare/Deleted detail modes are type-defined in `events.ts` but not yet rendered. When implementing diff2 modules, they consume `src/sync2/` (read `ConflictStore`, subscribe to `ConflictCounter`, use sync2 utils) but `src/sync2/` must not import from `src/diff2/` — see the dependency-direction rule in *Constraints to respect* below.

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
- **Polling, not events, for the sync engine.** `findChanges` walks the vault on each sync click; no `vault.on` subscription for sync purposes. Implication: edits made while the plugin was disabled get picked up on the next sync click without any "missed events" failure mode. The conflict layer's `ConflictWatcher` IS event-driven (`vault.on('delete'|'modify'|'rename')`), but **read-only** — it only calls `counter.markDirty()`, never mutates store; all conflict mutations happen at drain-start. See [`docs/SYNC2.md`](./docs/SYNC2.md) §1 (architecture layers + trigger models).
- **No scheduler logic in `main.ts`.** Periodic-tick decisions (interval enabled vs watchdog vs `syncStartsWithCommit`) and the onload-startup pulse live in `src/sync2/interval-scheduler.ts` so they can be unit-tested in isolation under a fake timer. If you find yourself adding an `setInterval` or `app.workspace.onLayoutReady` callback for sync purposes inside `main.ts`, move it into `IntervalScheduler` instead.
- **Worker orchestra: CPU pool + dedicated network worker.** Stage 4-6 of the 2.0.2-beta rework moved every hot-path CPU operation (3-way merge, base64 decode, SHA computation) and every GitHub HTTP call off the main thread. The orchestra lives in `src/worker/`; esbuild emits each worker entry point as a standalone IIFE and inlines the source as a string constant via `define`, so `main.js` ships a single bundle. Runtime wraps each string in a `Blob` URL and constructs `new Worker(url)` from it — no `importScripts`, no separate file fetch, no Capacitor `app://` URL ambiguity. Workers CANNOT touch any Obsidian API (`vault.adapter.*`, `app.workspace`, settings) — those stay on main. **All HTTP calls from the engine MUST go through `WorkerClient.httpRequest`** (CORS-validated against `api.github.com` on Capacitor Android). The Settings-tab connection probe is the one allowed exception — it uses `requestUrl` directly so a click never touches plugin state.
- **Modify-in-place uses `vault.modifyBinary` + a `.sync-tmp.` marker for crash safety.** When the engine writes to a file that already exists as a TFile, `atomicWriteFile` takes a fast path that preserves any open editor's cursor + scroll position. Protocol: stage new bytes in `<file>.sync-tmp.<ext>` → drop a zero-byte marker at `.<basename>.sync-tmp.` (leading + trailing dot — syntactically distinct from staging files) → `modifyBinary(target, newBytes)` → cleanup. On crash, `AtomicWriteRecovery.sweep` sees the marker, renames sync-tmp over the target (forward-complete), and removes the marker. Recovery runs at plugin onload BEFORE `workspace.onLayoutReady` so the rename's editor-close side effect is moot. The rename strategy still runs for brand-new files (no existing TFile to modify); SHA-based recovery handles its `.sync-bak` orphans, unchanged from 2.0.1.
- **`syncStartsWithCommit` master toggle controls all sync surfaces (default `true`).** Manual `[Sync]` click, interval tick, and startup sync all branch on this single setting. `true` → commit + drain (today's manual-click semantic; preserves backward compat). `false` → drain only; commit becomes the user's separate action via the `[Commit]` ribbon button or the `commit-local` command. The `showCommitRibbonButton` toggle controls the ribbon icon independently — it's a UI affordance, not a semantic.
- **`atomicWriteFile` is invoked from many places. Settings-tab UI text should NOT name engine concepts ("drain", "queue", "batch") — use plain English for users.** Engine identifiers (cancelDrain, DrainStatus, setDrainStatusListener) stay as code-level jargon because they're API names, not user copy. Stage 7 specifically swapped UI copy: "Drain status" → "GitHub sync status", "Stop drain" → "Stop sync", "Drain running" → "Syncing with GitHub".
- **`drain()` is re-entrant-safe via a `running` flag** on `Sync2Manager`. Concurrent `syncAll()` calls (e.g. interval tick fires while user click is mid-flight) collapse into one drain — the second call returns immediately. Don't bypass this with a separate code path; the integration suite's H3 test pins the serialisation.
- **Commit messages are hardcoded** in `src/sync2/commit-message.ts` (`formatSyncMessage`, `formatResolveConflictMessage`, etc.) — format `Sync at <local-time+offset> (deviceLabel)`. Don't reintroduce a per-user template field — the design choice was deliberate. The **local-commit timestamp lives in the message body on purpose**: sync2 commits locally (batch `createdAt`) but pushes later, so git's author/committer date records *push* time, not when the user committed. The in-message timestamp (rendered from `batch.createdAt` via `formatLocalTimestamp`) restores the true commit moment and makes every message unique/greppable. Provenance lives in the trailing `(deviceLabel)`, which `parseDeviceSuffix` recovers — keep the trailing-label contract intact. Rationale + the rejected "set author date" alternative: SYNC2.md §4.4.
- **When working on conflict resolution OR the push pipeline OR cross-cutting infrastructure** (cross-platform contracts in `cross-platform.ts`, typed errors in `errors.ts`, pending-deletions in `pending-deletions-store.ts`, skip-class annotations in any loop), [`docs/SYNC2.md`](./docs/SYNC2.md) is the canonical engine spec the code targets, and [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md) is the algorithm it realises. Code comments reference SYNC2.md section numbers (e.g. `SYNC2 §2.4` sibling staging, `SYNC2 §3` cross-platform contracts, `SYNC2 §4.1` pre-flight validation, `SYNC2 §5` error taxonomy, `SYNC2 §6` skip-class) and PSEUDO-MERGE-MODE.md numbers for algorithmic concepts (e.g. `§8 Scenario E`); use those to navigate between code and design rationale. The bug catalog in `SYNC2 §7 Field Postmortems` is the triage index for similar future symptoms.
- **When working on `src/diff2/`**, [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./docs/DIFF2_IMPLEMENTATION_PLAN.md) is the canonical spec. Diff2 is **purely additive UI/UX on top of pseudo-merge mode**: it must not change `ConflictStore` semantics, never bypass Phase A/B at drain start, and never push commits / mutate the conflict branch directly (that's `sync2-manager`'s job). The two operations diff2 may perform on the vault are (a) write base-file bytes through `atomicWriteFile`, and (b) `adapter.remove(siblingPath)` as the R7.11 proactive-cleanup step when `SHA(base) == SHA(sibling)`. Everything else is a `sync2/` concern that diff2 only observes.
- **Diff2 → sync2 dependency direction.** When `src/diff2/` modules start landing, they may import from `src/sync2/` (read `ConflictStore`, subscribe to `ConflictCounter`, observe `Sync2Manager` events). But **`src/sync2/` must never import from `src/diff2/`**. This keeps the sync engine buildable and testable without the UI layer (e.g., for sync-only regression runs and for the existing integration suite), and preserves the option to ship `src/diff2/` as a separate plugin later. Any new edge in `src/sync2/*.ts` that imports `../diff2/...` is a regression — surface it instead of bridging.
