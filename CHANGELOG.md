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

## 2.0.1-beta — earlier 2026

Initial release of **pseudo-merge mode** — the
sibling-file-based conflict-resolution model that this plugin is
built around. Full rationale in
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md).
