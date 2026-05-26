// Public types for src/diff2/. Kept minimal in this PR; expanded as
// later subsystems land (DiffPane chunk-actions, autosave, etc).

// On-disk record under .trash/<id>/meta.json.
//
// Canonical specs: docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.1, §R3.7.
// Field semantics overview:
//
//   id                  — 17-digit timestamp, directory name in .trash/<id>/,
//                         immutable for the lifetime of this entry. Layer 2
//                         of R3.5 sweepOlderThan compares this string
//                         lexicographically against drain.startedAt.
//   originalPath        — vault-relative path before delete (the path the
//                         file occupied in vault root). May be at root
//                         ("note.md") or nested ("Folder/note.md").
//   originalDeletedAt   — ISO-8601 timestamp for UI display ("deleted X ago").
//                         Preserved across lift→return cycles (R3.7) so the
//                         user-visible "deleted X ago" doesn't reset.
//   sha                 — blob SHA computed at delete time, for integrity
//                         checks and future GitHub-side dedup.
//   size, mtime         — file metadata snapshot at delete time.
//   liftedAsSessionId?  — when set, this entry is the focus of an active
//                         compare-lift session (R3.7). All three R3.5
//                         cleanup layers skip records with this field set
//                         — it's the load-bearing shield against drain
//                         reclaiming an entry mid-compare.
export interface TrashRecord {
  id: string;
  originalPath: string;
  originalDeletedAt: string;
  sha: string;
  size: number;
  mtime: number;
  liftedAsSessionId?: string;
}

// Constructor-injected by sync2-manager.ts to communicate trash-relevant
// events one-way (sync2 → diff2). diff2 implementations of these hooks
// are owned by TrashStore.asHooks(); sync2 holds the interface but never
// imports anything from src/diff2/.
//
// Canonical spec: docs/DIFF2_IMPLEMENTATION_PLAN.md R9 Phase 9a carve-out.
export interface TrashHooks {
  // Called by sync2.applyRemoteDeletion BEFORE adapter.remove(path).
  // Reads file bytes from vault and creates a .trash/<id>/ entry so the
  // user has one-drain-cycle recovery window for pull-deletes (R3.4).
  // Implementation MUST be best-effort: catch internal failure, log
  // warning, continue. sync2 proceeds with the delete regardless.
  captureForDelete(path: string): Promise<void>;

  // R3.5 Layer 1a — called by sync2.processBatch after a successful push.
  // Each path in `paths` is a base-file path the batch deleted on GitHub;
  // matching .trash/ entries are wiped.
  confirmDeleted(paths: string[]): Promise<void>;

  // R3.5 Layer 1b — called by sync2.processBatch after a successful push
  // of a side-batch with meta.resolvesConflictForBasePath set. All
  // sibling-trash entries belonging to that base-path (matched via
  // stripConflictSuffix) are wiped.
  confirmResolved(basePath: string): Promise<void>;

  // R3.5 Layer 2 — called by Sync2Manager at drain end, only when
  // drainSucceeded (queue empty, no abort). Wipes all .trash/<id>/ where
  // id < threshold. Threshold is drain.startedAt (17-digit timestamp).
  sweepOlderThan(threshold: string): Promise<void>;
}
