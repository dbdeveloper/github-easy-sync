// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault, TAbstractFile, EventRef } from "obsidian";
import ConflictStore from "./conflict-store";
import { ConflictCounter } from "./conflict-counter";

// ConflictWatcher. Subscribes to `vault.on('delete' | 'modify' |
// 'rename')` and, on each event, runs an O(1) fast-path Set check
// — is the touched path in ConflictStore as a base path OR a
// sibling path? If yes, calls `counter.markDirty()`. If no (99% of
// real vault traffic), bails out immediately.
//
// The watcher is READ-ONLY: it does NOT mutate the store, does NOT
// call evaluateConflictState, does NOT delete files. All resolution
// happens at drain-start (the single point of state mutation
// described in docs/PSEUDO-MERGE-MODE.md §5). The watcher's only
// job is to keep the UI counter reactive — when the user deletes a
// sibling, the badge updates before the next [Sync] click.
//
// The strict separation prevents the mid-drain races that arise when
// the same listener mutates state the drain is also writing.

export interface ConflictWatcherDeps {
  vault: Vault;
  store: ConflictStore;
  counter: ConflictCounter;
}

export class ConflictWatcher {
  private readonly vault: Vault;
  private readonly store: ConflictStore;
  private readonly counter: ConflictCounter;
  private refs: EventRef[] = [];

  constructor(deps: ConflictWatcherDeps) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.counter = deps.counter;
  }

  // Register vault listeners. Idempotent — calling start() twice
  // does NOT register duplicate handlers. Call this once at plugin
  // onload after the store has been loaded.
  start(): void {
    if (this.refs.length > 0) return;
    this.refs.push(
      this.vault.on("delete", (file: TAbstractFile) => {
        this.handle(file.path);
      }),
    );
    this.refs.push(
      this.vault.on("modify", (file: TAbstractFile) => {
        this.handle(file.path);
      }),
    );
    this.refs.push(
      this.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        // Both the new and old paths might be relevant: oldPath was a
        // sibling/base before the rename; the new path becomes one if
        // the user renamed sibling content onto base.
        this.handle(file.path);
        if (oldPath !== file.path) this.handle(oldPath);
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

  // Manually trigger handling for a path. Public for tests + for
  // callers that want to force a counter refresh without going
  // through the vault event dispatcher. O(1) — just the fast-path
  // Set check plus a counter.markDirty() call (which is itself
  // O(1) — sets a flag, schedules a debounced recompute).
  handle(path: string): void {
    if (!this.isRelevant(path)) return;
    this.counter.markDirty();
  }

  // O(1) fast-path: is `path` either a base file with active
  // conflicts OR a known sibling? Both checks go through
  // ConflictStore's in-memory indexes — no disk I/O.
  private isRelevant(path: string): boolean {
    return this.store.hasPending(path) || this.store.hasSibling(path);
  }
}
