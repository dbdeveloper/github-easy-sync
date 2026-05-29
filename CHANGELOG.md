# Changelog

All notable changes to **GitHub Easy Sync** are documented in this
file. The format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project tracks [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it leaves the `2.0.x-beta` line.

For the full design rationale behind any change below, see
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md).

---

## 2.0.1-beta5 — 2026-05-29

Hotfix release. Fixes a critical sync bug that could overwrite
remote files larger than 1 MB with truncated local copies.

### Fixed

- **Files larger than 1 MB now sync correctly.** GitHub's Contents
  API truncates inline content for files above ~1 MB; previous
  releases decoded the truncated response as 0 bytes, then ran the
  3-way reconcile against `remote = ∅` and (incorrectly) chose the
  local side. The fix transparently fetches the actual bytes via
  the Blobs API when the Contents API reports a large file. Affects
  every user with any single file above 1 MB; see
  [§16.6 of the design doc](./docs/PSEUDO-MERGE-MODE.md) for the
  full postmortem.

### Unchanged

- **No behaviour change for files at or below 1 MB.** The fast
  path is unchanged; the Blobs-API roundtrip only runs when the
  Contents response shows `size > 0` with empty inline content.

### Recovery if you were affected

If you suspect a recent sync replaced one of your notes on GitHub
with much smaller content, the previous versions of every file
remain in your repo's history — restore via `git revert <commit>`
from a clone, or copy from a previous commit on GitHub Web.

---

## 2.0.1-beta4 — 2026-05-25

Sync engine rebuilt from the ground up — both the
conflict-resolution layer and the push pipeline. Full mechanics in
[§Conflict resolution](./README.md#conflict-resolution); full
design rationale in
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md).

### Added

- **Resolve conflicts with plain file operations.** No modal
  dialogs, no `<<<<<<<` markers in your notes. Each conflict
  becomes an ordinary sibling file you handle with delete / rename
  / edit. *(A dedicated diff-edit GUI is planned for the next
  release; this release uses only the native Obsidian operations
  you already know.)*
- **Keep typing on a conflicted file.** Your in-progress edits
  flow to a private GitHub branch invisible to other devices until
  you finalise; the conflict doesn't block you.
- **Full edit history preserved on GitHub — forever.** Every commit
  the plugin produces — including every iteration during a
  conflict-resolution session — stays reachable in the Network
  graph. Nothing is silently squashed or discarded.
- **Three visibility surfaces for pending conflicts.** Status bar
  `🔀 N`, ribbon badge, pre-sync confirmation modal listing every
  pending file.
- **Push-queue depth visible on the ribbon.** The `[Sync with
  GitHub]` icon shows `(N)` when batches are waiting to drain —
  click feedback you can see, offline accumulations you can count,
  reconnection progress that decrements in front of you.

### Changed

- **Auto-merge first.** Text three-way merge, plugin-bundle
  semver, modify-vs-delete favours the modification. Only
  genuinely irreconcilable cases surface as siblings.
- **Crash-tolerant atomic writes.** Multi-step disk operations
  have a documented recovery sweep on plugin load; an interruption
  leaves the vault in either the pre- or post-state, never
  half-applied.
- **Multi-file conflict sessions resolve one file at a time.** Each
  per-file resolution lands on `main` as a regular commit; the
  conflict branch merges back only when the last file is settled.
- **`Reset` cleanly relabels siblings.** A wiped plugin state
  renames `*.conflict-from-*` files to
  `<file>.unresolved-<original-ts>.<ext>` so a future re-enable
  starts clean.
- **Cross-platform filename safety.** Files named with
  Windows-forbidden characters (`< > : " | ? * \`) or
  Obsidian-wiki-forbidden characters (`# ^ [ ]`) are automatically
  rewritten to canonical Unicode replacements on both push and
  pull. A vault authored on one platform stays usable from any
  other; see
  [§11 of the design doc](./docs/PSEUDO-MERGE-MODE.md).
- **Pre-flight validation on every push.** Stale deletion entries
  (a path another device already removed) are detected before the
  tree-create request is sent and dropped silently — no more 422
  `GitRPC::BadObjectState` failures from multi-device race
  conditions; see
  [§12.1 of the design doc](./docs/PSEUDO-MERGE-MODE.md).

---

## 2.0.1-beta3 — earlier 2026-05

Pre-flight validation hotfix (PUSH-REORGANIZATION Phase 1).
Detects stale deletion entries that another device already removed
on GitHub before issuing the `createTree` request, preventing
intermittent 422 `GitRPC::BadObjectState` failures. Now superseded
by the broader push-pipeline rework in `beta4`; see
[§12.1 of the design doc](./docs/PSEUDO-MERGE-MODE.md).

---

## 2.0.1-beta2 — earlier 2026-05

Cross-platform filename sync hotfix. Files named with
Windows-forbidden characters created on macOS / Linux desktop now
arrive correctly on Obsidian Android (which previously refused them
with `FILE_NOTCREATED`). Sanitization runs on both push and pull
sides so a vault converges on the canonical Unicode form after one
round-trip. Now part of the broader cross-platform contract in
`beta4`; see
[§11 of the design doc](./docs/PSEUDO-MERGE-MODE.md).

---

## 2.0.1-beta — 2026-05-23

Initial release of **pseudo-merge mode** — the
sibling-file-based conflict-resolution model that this plugin is
built around. Full rationale in
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md).

---

## 2.0.0-beta — 2026-05-15

**Rename and refocus.** The plugin was renamed from
`github-gitless-sync` to **`github-easy-sync`** to reflect a
year-long rework that turned a desktop-leaning REST-API sync into
a mobile-first, crash-tolerant engine with conflict-resolution as
a first-class feature. The fork started from
`github-gitless-sync@1.0.7` (see entry below); 96 commits later
this version landed.

### Engine — `sync2` rewrite

- **State machine for first sync**, with a user-facing modal only
  when the divergence is truly ambiguous. No more silent
  overwrites at adoption time; the engine mtime-checks every
  divergence and keeps local when local is newer.
- **Manifest as a first-class invariant.** A separate JSON file
  tracks the last-synced commit + per-path SHA snapshot;
  ChangeDetector walks the vault on each sync click instead of
  subscribing to live events, so edits made while the plugin was
  disabled are picked up on the next click — no "missed events"
  failure mode.
- **Atomic bare-repo bootstrap.** A brand-new GitHub repo (no
  commits yet) is seeded via the Contents API; subsequent writes
  retry on the documented 409 race.
- **Crash-resume across four layers** — adoption pull,
  incremental pull, push blob upload, and the find-changes →
  queue bridge. A sync interrupted mid-flight (Obsidian closed,
  phone backgrounded, network drop) finishes on the next trigger
  without duplicating commits.
- **Single network entry point.** `drain` (formerly
  `processQueue`) handles every pull + push combination; the
  legacy `SyncManager` is gone.
- **Reconcile handles all conflict types.** Delete-vs-modify
  promotes to a real conflict; auto-resolution short-circuits
  when both sides match; mtime-based "atomic conflicts" resolve
  without prompting.

### Conflict resolution — first complete UI

- **`DiffPane` widget** with per-chunk `[Theirs] / [Both] /
  [Ours]` action bar (CM6 widget decorations), keyboard
  navigation, and a status footer.
- **Vim-mappable chunk operations** exposed as Obsidian commands
  so power users can resolve from the keyboard alone.
- **"Resolve now" auto-opens the diff editor** for the affected
  file rather than dumping the user at a generic conflicts list.
- **Conflict sibling labelling.** Siblings carry the **GitHub
  author** of the incoming version, not the local device name —
  multi-device users can tell at a glance whose change is
  pending.
- **`ConflictStore` orphan cleanup on load.** A previous session
  that crashed mid-resolve leaves no dangling sibling rows.

### Filtering, settings, and per-device hygiene

- **Sync filtering moved to user-managed `.gitignore` files.** A
  unified `isSyncable` rule set drives every push and pull
  decision; users edit one well-known file instead of toggling
  thirty plugin settings.
- **`community-plugins.json` stops syncing by default** — it's
  per-device state, not vault content.
- **"Push plugins data.json to GitHub" toggle.** Off by default
  (most `data.json` files store API tokens); flip-on opt-in
  routes them through the same `.gitignore` machinery.
- **`syncConfigDir` default → false.** A first-time install no
  longer pushes the entire `.obsidian/` tree; opt in per device.
- **Auto-detect repo / owner / branch change** in settings, with
  a `[Reset]` button that wipes the local manifest cleanly when
  the user re-points the plugin at a new GitHub repo.
- **Settings UX polish.** Live preview under both commit-message
  templates; the `{date}` placeholder split into separate
  `{date}` and `{time}`; clearer labelling on Auto-commit and
  Sync-interval; default interval bumped 1 → 5 minutes.

### Notices and progress

- **Live N/M file counter** during push AND pull (text + binary
  both count toward the same denominator).
- **Click-time notice** confirms the sync started; **"Sync done"
  finale** summarises file counts updated from GitHub. Single-
  notice UX replaces the previous stacked-toast spam.
- **Bytes-based progress threshold + lazy notice.** Quick syncs
  stay silent; only the runs that take real time get a progress
  notice.

### Test infrastructure

- **Integration suite (~20 min, real GitHub)** with structured
  bucket series A through K plus the bootstrap suite. Buckets
  cover: bootstrap (A), adoption (B), resume after crash (C),
  incremental + delete races (D), edge cases (E), special chars
  + content (F), multi-device convergence (G), out-of-band drift
  (H), settings lifecycle (I), API failures (J), manifest
  corruption / recovery (K).
- **P-series performance baselines** (opt-in via
  `npm run test:perf`) for upload throughput.
- **Test-only `RequestFaultInjector`** lets J / K tests feed
  deterministic 429 / 5xx / network-drop responses into the retry
  loop without burning real PAT quota.

### Mobile robustness

- **Android first-sync crash fixed** — large initial syncs now
  use per-file Contents API calls instead of a single tree-blob
  download that OOM'd Capacitor.
- **Adoption-time path trimming and canonicalisation** so a vault
  bootstrapped on desktop arrives on Android without
  `FILE_NOTCREATED` errors.

### Developer tooling

- **`OBSIDIAN_PLUGIN_DIR` env var** (with `~` expansion fixed for
  IDE-set values) mirrors `main.js` / `manifest.json` /
  `styles.css` straight into a vault on every `pnpm dev` build —
  no more manual `cp` between rebuilds.

For the canonical engine spec, see
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md);
the design rationale article was written immediately after this
release to capture the model in one place.

---

## github-gitless-sync 1.0.7 — 2025-05-22 (fork point)

The version of the upstream
[`github-gitless-sync`](https://github.com/silvanocerza/github-gitless-sync)
plugin from which this fork was taken. Authored by
[Silvano Cerza](https://silvanocerza.com); the fork inherits
that work, the AGPL-3.0 licence, and the original
"vault-to-GitHub via REST API only" idea.

### Carried forward into the fork

- **GitHub REST API only.** No `git` binary, no `isomorphic-git`
  — the architectural decision that lets the same code run on
  desktop and on Obsidian Mobile.
- **Commit-message templating** with placeholders.
- **`Sync now` command + ribbon + status bar** entry points.
- **Settings tab** with token / owner / repo / branch
  configuration and a connection-test probe.

### Notable fixes shipped in upstream's 1.0.7 itself

- **Sync correctly handles deleted, moved, and renamed files.**
  Previously a delete or rename on either side could leave the
  vault and remote tree mismatched.

For the upstream changelog and earlier versions of the
gitless-sync line, see
[silvanocerza/github-gitless-sync](https://github.com/silvanocerza/github-gitless-sync).
