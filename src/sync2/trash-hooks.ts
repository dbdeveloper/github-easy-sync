// TrashHooks — sync2-owned interface for trash-relevant events.
// Sync2Manager constructor accepts an optional implementation; diff2's
// TrashStore.asHooks() returns one. Defined here in sync2/ (not in
// src/diff2/) so the sync engine builds standalone — `pnpm build`
// must succeed even with src/diff2/ removed (sync-only regression
// runs, future "sync2 as separate plugin" option).
//
// Canonical spec: docs/DIFF2_IMPLEMENTATION_PLAN.md R9 Phase 9a
// carve-out. The four callbacks correspond to the four touchpoints
// where sync2 needs to notify the trash subsystem:
//
//   captureForDelete  — applyRemoteDeletion, just before adapter.remove
//                       (R3.4 — pull-delete capture).
//   confirmDeleted    — processBatch success path, with the batch's
//                       deleted-paths.txt entries (R3.5 layer 1a).
//   confirmResolved   — processBatch success for Phase B side-batches
//                       (R3.5 layer 1b; uses
//                       batch.meta.resolvesConflictForBasePath).
//   sweepOlderThan    — drain end, only when drainSucceeded
//                       (R3.5 layer 2; threshold = drain.startedAt).
//
// All four are async, return void, and MUST be best-effort on the
// caller side: a hook failure does not block the sync operation —
// trash is a safety net, not a hard dependency.

export interface TrashHooks {
  captureForDelete(path: string): Promise<void>;
  confirmDeleted(paths: string[]): Promise<void>;
  confirmResolved(basePath: string): Promise<void>;
  sweepOlderThan(threshold: string): Promise<void>;
}
