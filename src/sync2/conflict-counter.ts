// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Pseudo-merge Stage 13 conflict counter (Phase 1.7 stub —
// Phase 4 implementation pending).
//
// Spec: PSEUDO-MERGE-MODE.md §"ConflictCounter — dirty-flag +
// subscribers contract" and §"Counter formula + vault.on listeners
// role".
//
// Contract summary (binding for Phase 4 fill-in):
//
//   - vault.on listeners are READ-ONLY. They call markDirty() on
//     relevant events (paths in ConflictStore.siblingPaths ∪
//     ConflictStore.basePaths). Listeners NEVER mutate the store,
//     NEVER call evaluateConflictState, NEVER delete files.
//
//   - markDirty() is O(1): sets dirty flag, schedules debounced
//     recompute on next microtask. Multiple back-to-back calls
//     coalesce into one recompute + one subscriber-notify round.
//
//   - getValue() is O(N records) when dirty (recompute then return),
//     O(1) when cached. Synchronous-feeling for on-demand readers
//     (pre-sync modal at open time).
//
//   - Recompute formula (from §"Counter formula"):
//       count = 0
//       for record in store.records:
//         if !exists(record.siblingPath): continue   // dropped on next drain
//         if !exists(record.vaultPath):    count++   // base gone, sibling alone
//         if record.siblingSha != record.baseSha: count++  // SHA mismatch
//         // siblingSha == baseSha: not counted (Phase A auto-cleans)
//
//   - subscribe() registers a callback that fires after each
//     recompute, but ONLY if the value changed. Returns an
//     unsubscribe function. Subscribers used by status bar +
//     ribbon for reactive UI.
//
// Phase 3 RED tests will exercise this class against the spec
// behavior and observe "Not implemented" — proper RED state.
// Phase 4 fills in the bodies.

import { Vault } from "obsidian";
import ConflictStore from "./conflict-store";

export interface ConflictCounterDeps {
  vault: Vault;
  store: ConflictStore;
  // Override clock for deterministic tests.
  now?: () => number;
  // Override microtask scheduler for deterministic tests (default
  // queueMicrotask). Tests inject a synchronous flushable scheduler.
  scheduleMicrotask?: (fn: () => void) => void;
}

export type CountChangeCallback = (count: number) => void;

export class ConflictCounter {
  constructor(_deps: ConflictCounterDeps) {
    // Phase 4 wires up the dependencies. Stub stores nothing.
  }

  // O(1). Sets dirty flag and schedules debounced recompute on next
  // microtask. Multiple calls within the same microtask coalesce
  // into one recompute round.
  markDirty(): void {
    throw new Error(
      "ConflictCounter.markDirty: not implemented (Stage 13 Phase 4)",
    );
  }

  // Synchronous read. Recomputes if dirty (O(N records)), returns
  // cached value otherwise (O(1)). Used by on-demand readers (modals).
  getValue(): number {
    throw new Error(
      "ConflictCounter.getValue: not implemented (Stage 13 Phase 4)",
    );
  }

  // Subscribe to count changes. Callback fires after each recompute
  // IF and only if the value changed. Returns an unsubscribe function.
  // Used by reactive UI (status bar, ribbon badge).
  subscribe(_callback: CountChangeCallback): () => void {
    throw new Error(
      "ConflictCounter.subscribe: not implemented (Stage 13 Phase 4)",
    );
  }

  // For tests + drain wiring: force immediate recompute (bypasses
  // microtask debouncing). Useful at drain-end if you want the
  // counter synced before checking finalize condition. Not part of
  // the hot-path contract.
  async flush(): Promise<void> {
    throw new Error(
      "ConflictCounter.flush: not implemented (Stage 13 Phase 4)",
    );
  }
}
