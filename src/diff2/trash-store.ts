// Local "smart-trash" for user-driven deletes, with cross-drain cleanup
// hooks that let sync2 reclaim trashed entries as their corresponding
// deletes propagate to GitHub.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R3 (Recently deleted / Local trash)
//   - docs/tasks/TASK_9A_TRASH_CORE.md (this PR's home spec)
//
// Architectural notes worth re-stating in code:
//
//  - Disk is single source of truth. TrashStore holds no in-memory
//    record cache; every query (list/get/iter) scans .trash/ via
//    readdir + parse N×meta.json. Realistic N ≈ 3–20 entries (R3.5
//    cleanup keeps it small), so the scan is microseconds even on
//    mobile. The state TrashStore DOES hold in memory is just the
//    promise-chain for serialization and the listener set.
//
//  - All mutating methods serialize through serialize(). Concurrent
//    invokers don't interleave at the operation level; race surface
//    against external (drain-side) iteration is described in R3.7.
//
//  - Pull-deletes are NOT bypassed (R3.4 reformulated). sync2 calls
//    captureForDelete via the constructor-injected hook before its own
//    adapter.remove. Both user-driven (monkey-patched vault.delete) and
//    pull-driven flows funnel through intercept(path).
//
// PR-3 scope: skeleton, init(), intercept(), serialize(), subscribe(),
// list(), get(). The remaining hooks (confirmDeleted/confirmResolved/
// sweepOlderThan) and operations (liftForCompare/returnFromCompare/
// resetLifts) land in later PRs; their stubs throw so accidental early
// wire-up surfaces loudly.

import { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import { newBatchId, parseTimestampId } from "../sync2/timestamp-id";
import {
  atomicWriteJson,
  ensureParentDirs,
  tryReadMetaJson,
} from "./trash-disk-helpers";
import { TrashHooks, TrashRecord } from "./types";

const TRASH_DIRNAME = ".trash";
const VAULT_SUBDIR = "vault";
const META_FILE = "meta.json";

export interface TrashStoreDeps {
  vault: Vault;
  configDir: string;
  selfPluginId: string;
  // Test-only clock override. Production passes undefined → Date.now().
  now?: () => Date;
}

export class TrashStore {
  private readonly vault: Vault;
  private readonly trashRoot: string;
  private readonly nowFn: () => Date;
  private currentOp: Promise<unknown> = Promise.resolve();
  private listeners: Set<() => void> = new Set();

  constructor(deps: TrashStoreDeps) {
    this.vault = deps.vault;
    this.trashRoot = `${deps.configDir}/plugins/${deps.selfPluginId}/${TRASH_DIRNAME}`;
    this.nowFn = deps.now ?? (() => new Date());
  }

  // ── lifecycle ─────────────────────────────────────────────────────

  // Ensure the trash root directory exists. Idempotent. No disk scan —
  // the spec is explicit that TrashStore is stateless w.r.t. records.
  async init(): Promise<void> {
    if (!(await this.vault.adapter.exists(this.trashRoot))) {
      await this.vault.adapter.mkdir(this.trashRoot);
    }
  }

  // ── intercept ─────────────────────────────────────────────────────

  // Copy a vault file's bytes into a fresh .trash/<id>/ entry. The
  // caller is responsible for performing the actual removal from vault
  // AFTER intercept resolves — TrashStore only handles the "save the
  // bytes" half of the protocol.
  //
  // Called from two flows that both predate the actual vault.remove:
  //   (a) trash-watcher's monkey-patched vault.delete/trash (later PR)
  //   (b) asHooks().captureForDelete from sync2.applyRemoteDeletion
  //
  // Returns the persisted TrashRecord. Throws on read/write failure;
  // callers in the monkey-patch wrapper / sync hook should catch and
  // log, but proceed with the underlying delete regardless — TrashStore
  // is a best-effort safety net, not a sync blocker.
  async intercept(path: string): Promise<TrashRecord> {
    return this.serialize(() => this.interceptImpl(path));
  }

  private async interceptImpl(path: string): Promise<TrashRecord> {
    const id = await this.allocateUniqueId();
    const adapter = this.vault.adapter;

    const fileContent = await adapter.readBinary(path);
    const sha = await calculateGitBlobSHA(fileContent);
    const stat = await adapter.stat(path);
    const size = stat?.size ?? fileContent.byteLength;
    const mtime = stat?.mtime ?? Date.now();

    const dstFile = `${this.trashRoot}/${id}/${VAULT_SUBDIR}/${path}`;
    await ensureParentDirs(adapter, dstFile);
    await adapter.writeBinary(dstFile, fileContent);

    const meta: TrashRecord = {
      id,
      originalPath: path,
      originalDeletedAt: new Date().toISOString(),
      sha,
      size,
      mtime,
    };
    await atomicWriteJson(
      adapter,
      `${this.trashRoot}/${id}/${META_FILE}`,
      meta,
    );

    this.notify();
    return meta;
  }

  // ── queries (disk-scan; no in-memory index) ───────────────────────

  // Return all valid TrashRecords. Sorts newest-deleted first (by
  // originalDeletedAt desc), matching the "Recently deleted" UI order.
  // Skips trash dirs with missing/invalid meta.json — those are orphan
  // states the recovery sweep (later PR) handles separately.
  async list(): Promise<TrashRecord[]> {
    const adapter = this.vault.adapter;
    if (!(await adapter.exists(this.trashRoot))) return [];
    const { folders } = await adapter.list(this.trashRoot);
    const out: TrashRecord[] = [];
    for (const dir of folders) {
      const meta = await tryReadMetaJson<TrashRecord>(
        adapter,
        `${dir}/${META_FILE}`,
      );
      // Defensive: dir name must equal meta.id to prevent reading
      // half-renamed entries from a partial recovery.
      const dirName = dir.slice(dir.lastIndexOf("/") + 1);
      if (meta && meta.id === dirName) out.push(meta);
    }
    out.sort((a, b) => b.originalDeletedAt.localeCompare(a.originalDeletedAt));
    return out;
  }

  // Single-record lookup by id. Returns undefined when the record is
  // missing OR its meta.json is invalid.
  async get(id: string): Promise<TrashRecord | undefined> {
    const meta = await tryReadMetaJson<TrashRecord>(
      this.vault.adapter,
      `${this.trashRoot}/${id}/${META_FILE}`,
    );
    return meta && meta.id === id ? meta : undefined;
  }

  // ── subscription (bare signal; UI re-fetches via list()) ──────────

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A misbehaving subscriber must not break TrashStore. Swallow
        // and continue — listeners are UI-side and recoverable.
      }
    }
  }

  // ── sync2 cross-edge: TrashHooks adapter ──────────────────────────

  // Returns the bag of callbacks sync2 imports via constructor
  // injection. captureForDelete is wired to intercept; the other three
  // hooks are PR-5 work and currently throw to surface accidental
  // early wire-up.
  asHooks(): TrashHooks {
    return {
      captureForDelete: async (path) => {
        await this.intercept(path);
      },
      confirmDeleted: async (_paths) => {
        throw new Error(
          "TrashStore.confirmDeleted not implemented in PR-3 (lands in PR-5)",
        );
      },
      confirmResolved: async (_basePath) => {
        throw new Error(
          "TrashStore.confirmResolved not implemented in PR-3 (lands in PR-5)",
        );
      },
      sweepOlderThan: async (_threshold) => {
        throw new Error(
          "TrashStore.sweepOlderThan not implemented in PR-3 (lands in PR-5)",
        );
      },
    };
  }

  // ── internals ─────────────────────────────────────────────────────

  // Serializes mutating operations through a promise-chain. Each public
  // mutator wraps its body in serialize() so concurrent callers never
  // interleave their atomic-write steps. Failure of one operation
  // doesn't poison the chain — the next caller's `await prev` swallows
  // the rejection.
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const prev = this.currentOp;
    const next = (async (): Promise<T> => {
      try {
        await prev;
      } catch {
        // intentionally ignored — see method doc
      }
      return op();
    })();
    this.currentOp = next.catch(() => {});
    return next;
  }

  // Mirrors push-queue.ts::allocateUniqueId: handles the rare case where
  // two intercepts land in the same millisecond by bumping the trailing
  // ms-counter until the directory doesn't yet exist. Keeps the total
  // order monotonic — load-bearing for layer 2 sweep (R3.5) which
  // compares id < drain.startedAt lexicographically.
  private async allocateUniqueId(): Promise<string> {
    let id = newBatchId(this.nowFn());
    while (
      await this.vault.adapter.exists(`${this.trashRoot}/${id}`)
    ) {
      const next = new Date(parseTimestampId(id) + 1);
      id = newBatchId(next);
    }
    return id;
  }
}
