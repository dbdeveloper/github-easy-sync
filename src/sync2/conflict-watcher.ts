// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault, TAbstractFile, EventRef } from "obsidian";
import ConflictStore from "./conflict-store";
import {
  evaluateConflictState,
  EvaluationResult,
} from "./conflict-classifier";

// Pseudo-merge ConflictWatcher (PSEUDO-MERGE-MODE.md §"Trigger
// points").
//
// Subscribes to `vault.on('delete' | 'modify' | 'rename')` and, on
// each event, runs the O(1) fast-path Set check — is the touched
// path in ConflictStore as a base path OR a sibling path? If yes,
// triggers a full `evaluateConflictState()` sweep. If no (99% of
// real vault traffic), bails out immediately.
//
// This is the explicit exception to the sync-engine's polling rule
// (CLAUDE.md §"Polling model"). The conflict-resolution layer needs
// real-time state updates so the user sees status-bar counts move
// the moment they delete a sibling.
//
// Drain orchestration owns pause() / resume() — events fire freely
// outside drain, are dropped during drain, and the drain-start +
// drain-end sweeps recover any missed state via fs scan.

export interface ConflictWatcherDeps {
  vault: Vault;
  store: ConflictStore;
  // Fired after `evaluateConflictState()` completes because of a
  // vault event. Drain wiring will consume the result to refresh the
  // status bar, synthesize side-batches when paths close, etc.
  onResolution?: (result: EvaluationResult) => void | Promise<void>;
  // Override clock for deterministic tests.
  now?: () => number;
  // Optional error sink. Errors thrown inside the chained evaluation
  // are otherwise swallowed (so a single bad sweep doesn't kill the
  // whole watcher). Drain/main.ts will wire this to the plugin logger.
  onError?: (err: unknown) => void;
}

export class ConflictWatcher {
  private readonly vault: Vault;
  private readonly store: ConflictStore;
  private readonly onResolution: ConflictWatcherDeps["onResolution"];
  private readonly nowFn: () => number;
  private readonly onError: ConflictWatcherDeps["onError"];
  private refs: EventRef[] = [];
  private paused = false;
  // Chained promise that serializes back-to-back evaluations so
  // concurrent vault events don't race on store mutations. Each
  // queued task re-checks fast-path relevance because earlier
  // evaluations may have already resolved the conflict.
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: ConflictWatcherDeps) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.onResolution = deps.onResolution;
    this.nowFn = deps.now ?? (() => Date.now());
    this.onError = deps.onError;
  }

  // Register vault listeners. Idempotent — calling start() twice
  // does NOT register duplicate handlers. Call this once at plugin
  // onload after the store has been loaded.
  start(): void {
    if (this.refs.length > 0) return;
    this.refs.push(
      this.vault.on("delete", (file: TAbstractFile) => {
        void this.handle(file.path);
      }),
    );
    this.refs.push(
      this.vault.on("modify", (file: TAbstractFile) => {
        void this.handle(file.path);
      }),
    );
    this.refs.push(
      this.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        // Both the new and old paths might be relevant: oldPath was a
        // sibling/base before the rename; the new path becomes one if
        // the user renamed sibling content onto base (case 6 trigger).
        void this.handle(file.path);
        if (oldPath !== file.path) void this.handle(oldPath);
      }),
    );
  }

  // Unsubscribe from vault events. Called from plugin onunload.
  stop(): void {
    for (const ref of this.refs) {
      this.vault.offref(ref);
    }
    this.refs = [];
  }

  // Pause event processing — drain calls this at the start of each
  // batch pipeline so that mid-drain sibling-writes don't loop us
  // back into evaluateConflictState mid-batch. Per spec
  // §"Архітектура push: split-push у processBatch", events that
  // arrive during pause are effectively dropped (Obsidian events
  // are not buffered); the drain-start + drain-end full sweeps
  // re-evaluate ConflictStore vs file system to catch any state
  // change that happened while paused.
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // Manually trigger handling for a path. Public for two reasons:
  //   1. Tests drive this directly to avoid mocking the full
  //      Obsidian event dispatcher.
  //   2. Callers that detect a state-relevant change outside the
  //      vault.on stream (e.g., the eventual drain-start sweep
  //      will call evaluateConflictState() unconditionally) can
  //      route through here for consistent serialization.
  //
  // The returned promise resolves AFTER this specific evaluation
  // completes (or was skipped). Concurrent calls are serialized
  // through the internal chain.
  async handle(path: string): Promise<void> {
    if (this.paused) return;
    if (!this.isRelevant(path)) return;

    const task = this.chain.then(async () => {
      // Re-check inside the queued task — by the time we run, a
      // prior queued evaluation may have already resolved this path
      // and removed all relevant records. Skip in that case to
      // avoid an empty sweep.
      if (this.paused) return;
      if (!this.isRelevant(path)) return;
      try {
        const result = await evaluateConflictState(
          this.store,
          this.vault,
          this.nowFn,
        );
        if (this.onResolution) await this.onResolution(result);
      } catch (err) {
        if (this.onError) this.onError(err);
        // Swallow — chain must stay alive for subsequent events.
      }
    });
    // Keep the chain alive even if a task throws. catch attaches a
    // no-op handler on the chain reference; the original promise's
    // rejection still propagates to the awaited return value via the
    // explicit try/catch above.
    this.chain = task.catch(() => undefined);
    return task;
  }

  // Wait for the in-flight chain to fully drain. Used by tests
  // (since vault.on dispatchers in mock-obsidian don't return a
  // promise) and by drain wiring at end-of-batch to ensure no
  // straggling evaluations interleave with the next phase.
  async flush(): Promise<void> {
    await this.chain;
  }

  // O(1) fast-path: is `path` either a base file with active
  // conflicts OR a known sibling? Both checks go through
  // ConflictStore's in-memory indexes — no disk I/O.
  private isRelevant(path: string): boolean {
    return this.store.hasPending(path) || this.store.hasSibling(path);
  }
}
