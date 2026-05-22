// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Pseudo-merge Stage 13 conflict counter — Phase 4 Group 5
// implementation of the contract from PSEUDO-MERGE-MODE.md
// §"ConflictCounter — dirty-flag + subscribers contract" and
// §"Counter formula + vault.on listeners role".
//
// Contract summary (binding):
//
//   - vault.on listeners are READ-ONLY. They call markDirty() on
//     relevant events (paths in ConflictStore.siblingPaths ∪
//     ConflictStore.basePaths). Listeners NEVER mutate the store,
//     NEVER call evaluateConflictState, NEVER delete files.
//
//   - markDirty() is O(1): sets dirty flag, schedules at most ONE
//     debounced recompute via the supplied microtask scheduler.
//     Multiple back-to-back calls coalesce into one scheduled task.
//
//   - getValue() is O(1): returns the CACHED count. Callers that need
//     a guaranteed-fresh value await flush() first.
//
//   - flush() is async: runs the recompute INLINE (does NOT wait for
//     the scheduler to fire). Loops until quiescent (dirty cleared
//     and no in-flight recompute). Used by drain at start/end and
//     by tests.
//
//   - subscribe(cb) registers a callback that fires after each
//     recompute, but ONLY if the value CHANGED. Returns an
//     unsubscribe function. Subscribers used by status bar +
//     ribbon for reactive UI.
//
// Recompute formula (from §"Counter formula"):
//   count = 0
//   for record in store.records:
//     if !exists(record.siblingPath): continue   // dropped on next drain
//     if !exists(record.vaultPath):    count++   // base gone, sibling alone
//     if record.siblingSha != record.baseSha: count++  // SHA mismatch
//     // siblingSha == baseSha: not counted (Phase A auto-cleans)

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
  private readonly vault: Vault;
  private readonly store: ConflictStore;
  private readonly scheduleMicrotask: (fn: () => void) => void;

  private cachedValue: number = 0;
  private dirty: boolean = false;
  // True while a microtask is queued but hasn't fired yet. Prevents
  // bulk markDirty() from queueing N tasks for one debounce window.
  private scheduled: boolean = false;
  // Non-null while a recompute is actually running. flush() awaits
  // this; markDirty() does not re-schedule if it's set (the in-flight
  // run will re-arm via the post-await dirty-check loop below).
  private currentRun: Promise<void> | null = null;
  private readonly subscribers: Set<CountChangeCallback> = new Set();

  constructor(deps: ConflictCounterDeps) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.scheduleMicrotask =
      deps.scheduleMicrotask ?? ((fn) => queueMicrotask(fn));
  }

  // O(1). Sets the dirty flag and schedules at most one debounced
  // recompute via the microtask scheduler. Back-to-back calls
  // coalesce into one scheduled callback.
  markDirty(): void {
    this.dirty = true;
    if (this.scheduled || this.currentRun !== null) return;
    this.scheduled = true;
    this.scheduleMicrotask(() => {
      this.scheduled = false;
      void this.runIfDirty();
    });
  }

  // O(1). Returns the cached count. UI surfaces (status bar, ribbon)
  // either subscribe() or check this after their own flush().
  getValue(): number {
    return this.cachedValue;
  }

  // Subscribe to count changes. Callback fires after each recompute
  // IF and only if the new value differs from the previous cache.
  // Returns an unsubscribe function.
  subscribe(callback: CountChangeCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  // Force the recompute to run NOW, bypassing the microtask debounce.
  // Loops until quiescent (no dirty flag set, no in-flight run) so
  // markDirty() calls landing during a recompute are picked up.
  async flush(): Promise<void> {
    while (this.dirty || this.currentRun !== null) {
      if (this.currentRun !== null) {
        await this.currentRun;
      } else {
        await this.runIfDirty();
      }
    }
  }

  // ── internals ─────────────────────────────────────────────────────

  private async runIfDirty(): Promise<void> {
    if (!this.dirty) return;
    if (this.currentRun !== null) {
      // A run is already in progress — await it. The post-await
      // dirty-check loop in flush() will start another if needed.
      await this.currentRun;
      return;
    }
    this.dirty = false;
    this.currentRun = (async () => {
      const newCount = await this.computeCount();
      const changed = newCount !== this.cachedValue;
      this.cachedValue = newCount;
      if (changed) {
        // Snapshot so subscribers can unsubscribe during the loop
        // without invalidating iteration.
        for (const cb of [...this.subscribers]) {
          try {
            cb(newCount);
          } catch {
            // Best-effort: a throwing subscriber doesn't stop the rest.
          }
        }
      }
    })();
    try {
      await this.currentRun;
    } finally {
      this.currentRun = null;
    }
  }

  private async computeCount(): Promise<number> {
    let count = 0;
    for (const record of this.store.getAll()) {
      const siblingExists = await this.vault.adapter.exists(
        record.siblingPath,
      );
      if (!siblingExists) {
        // Will be dropped on the next drain Phase B — not counted.
        continue;
      }
      const baseExists = await this.vault.adapter.exists(record.vaultPath);
      if (!baseExists) {
        // Base gone, sibling alone — counted as a conflict.
        count++;
        continue;
      }
      if (record.siblingSha !== record.baseSha) {
        // SHA mismatch — real unresolved divergence.
        count++;
      }
      // siblingSha === baseSha: Phase A auto-cleans on next drain.
      // Not counted.
    }
    return count;
  }
}
