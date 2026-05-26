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

// TrashHooks is defined sync2-side (src/sync2/trash-hooks.ts) so the
// sync engine builds standalone without src/diff2/. diff2 re-exports
// it for callers that already live in diff2 and don't want a longer
// import path. See R9 Phase 9a carve-out.
export type { TrashHooks } from "../sync2/trash-hooks";
