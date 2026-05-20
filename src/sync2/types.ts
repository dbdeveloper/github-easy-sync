// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Types shared across the sync2 stack. Kept deliberately small and free
// of legacy field carry-over: sync2 builds its own state model, it does
// not consume the legacy manifest schema.

// One file's place in the sync world from sync2's point of view.
// Only files that have made at least one round-trip with GitHub are
// represented; files added locally and not yet pushed are simply
// absent from the snapshot store and surface as `added` from
// ChangeDetector.findChanges() until they're pushed.
export type FileSnapshot = {
  // POSIX path relative to vault root.
  path: string;
  // Git blob SHA last seen on the remote for this path.
  remoteSha: string;
  // mtime+size pair of the local file at the moment remoteSha was
  // recorded. Used by ChangeDetector to short-circuit unchanged files
  // without reading them.
  mtime: number;
  size: number;
};

// A change discovered by ChangeDetector for one file.
export type FileChange =
  | { kind: "added"; path: string; size: number; mtime: number }
  | {
      kind: "modified";
      path: string;
      size: number;
      mtime: number;
      previousRemoteSha: string;
    }
  | { kind: "deleted"; path: string; previousRemoteSha: string };

// One push-queue batch waiting on disk. Always represents the user's
// intent at the moment the batch was enqueued; later edits do not
// retroactively mutate it. The one writable slot is `uploadedBlobs`,
// which tracks per-file `createBlob` results for resume — see below.
export type QueueBatch = {
  // Timestamp-suffixed directory name, e.g. "20260503093823777".
  id: string;
  // Whether the runner is currently uploading this batch. Persisted as
  // an ".in-progress" marker file inside the batch directory.
  inProgress: boolean;
  // Whether the runner has ever started pushing this batch — set
  // when processBatch begins and NEVER cleared (the only cleanup is
  // queue.delete on commit success). Once set, the batch is
  // "frozen": mergeIntoLatestPending refuses to fold new changes
  // into it even when accumulateOfflineSyncs is on. Models the
  // user's rule "in-progress OR failed batch is blocked from
  // merges; new sync clicks create a new batch instead".
  attempted: boolean;
  // Commit message to use for this batch's commit. Templated at enqueue
  // time so subsequent settings edits can't change a queued message.
  commitMessage: string;
  // Snapshot of the parent commit SHA at enqueue time. Used as the
  // first-pick parent; if the remote has moved since, the runner
  // resolves the conflict before pushing.
  parentCommitSha: string | null;
  // Snapshot of the parent's tree SHA. Reused as `base_tree` so the
  // POST tree request ships only the changed entries.
  parentTreeSha: string | null;
  // Files included in this batch, by path relative to the batch's
  // vault/ subdirectory.
  files: string[];
  // Paths to delete on the remote, listed verbatim from
  // deleted-paths.txt.
  deletions: string[];
  // Per-file blob SHAs that `createBlob` already returned for this
  // batch in a prior (possibly crashed) attempt. Resume of an
  // interrupted push consults this map before issuing another
  // createBlob — if `path` is present, the SHA is reused inline in
  // the tree entry and the network call is skipped. Empty on first
  // attempt; populated incrementally as `createBlob` calls succeed.
  // Survives across plugin reloads because it lives in .meta.json.
  // Cleared implicitly when the batch dir is deleted on commit
  // success — staleness is impossible by construction.
  uploadedBlobs: Record<string, string>;
  // mtime per snapshotted file, captured at enqueue time BEFORE
  // copyFileFromVault's canonical-write-back can bump the live vault
  // file's mtime. Reconcile uses this as the local-side timestamp
  // for binary/plugin-js atomic resolution — using the live mtime
  // instead would silently flip the answer toward "local wins" any
  // time canonicalization rewrote the file. Empty for batches that
  // predate this field (defensive — caller falls back to 0).
  fileMtimes: Record<string, number>;
};

// Outcome of a 3-way merge attempt.
export type MergeResult =
  | { kind: "clean"; content: string }
  | {
      kind: "conflict";
      // Marker-laden text the conflict modal will show.
      conflictMarkedContent: string;
    };

// What the user (or test stub) chose when sync2 surfaced a conflict
// it couldn't auto-resolve. Three flavours, matching the per-file
// modal in Stage 6.5:
//   - resolved        — user picked "Resolve now" and finished merging
//                       through the diff editor. `content` overwrites
//                       the local file and goes up on the next push.
//   - deferred        — user picked "Later". The conflict-store has
//                       already been told to capture (base, theirs)
//                       and write the sibling file in the vault. The
//                       local copy stays as `ours`; sync2 excludes
//                       this path from push until resolution arrives.
//   - merged-into-one — markdown-only "auto-merge" via callouts; the
//                       merged document overwrites the local file and
//                       goes up like a regular `resolved`. Named
//                       separately for logging/telemetry clarity.
export type ConflictResolution =
  | { kind: "resolved"; content: string }
  | { kind: "deferred" }
  | { kind: "merged-into-one"; content: string };

// Placeholder substitutions allowed in commit-message templates.
//
// Note: deviceLabel is intentionally NOT a placeholder. It's appended
// as a fixed-position trailing " (deviceLabel)" suffix by
// appendDeviceSuffix() so it lands at a reliable, parseable position
// regardless of how the user edited their template — the regex
// /\s\(([^)]+)\)$/ pulls it back out of any commit on GitHub.
export type CommitMessagePlaceholders = {
  date?: Date;
  filename?: string;
  path?: string;
};
