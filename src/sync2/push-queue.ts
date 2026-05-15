import { Vault } from "obsidian";
import { calculateGitBlobSHA, hasTextExtension } from "../utils";
import { normalizeText } from "./text-normalize";
import { FileChange, QueueBatch } from "./types";

// Layout:
//   <configDir>/plugins/<self>/.push-queue/
//     20260503093823777/
//       .in-progress      ← present iff this batch is being uploaded
//       .meta.json        ← { commitMessage, parentCommitSha, parentTreeSha, createdAt }
//       deleted-paths.txt ← optional; one path per line
//       vault/            ← mirrors actual vault structure
//         Folder/note.md
//         attachments/img.png
//
// The `vault/` sub-root is mandatory: without it, vault files named
// `.meta.json`, `.in-progress`, or `deleted-paths.txt` would collide
// with our control files.

const QUEUE_DIRNAME = ".push-queue";
const META_FILE = ".meta.json";
const IN_PROGRESS_FILE = ".in-progress";
// Written by processBatch on first start; NEVER cleared on failure
// (the only removal is the whole batch dir on commit success). Once
// set, mergeIntoLatestPending skips this batch — see the "frozen on
// first attempt" rule in QueueBatch.attempted's doc.
const ATTEMPTED_FILE = ".attempted";
const DELETIONS_FILE = "deleted-paths.txt";
const VAULT_SUBDIR = "vault";

// Batch ID format: YYYYMMDDhhmmssfff in UTC. Lexicographic order
// equals chronological order, so list() can sort cheaply by name.
function newBatchId(now: Date = new Date()): string {
  const pad = (n: number, width = 2) => n.toString().padStart(width, "0");
  return (
    `${now.getUTCFullYear()}` +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) +
    pad(now.getUTCMilliseconds(), 3)
  );
}

export type EnqueueMeta = {
  commitMessage: string;
  parentCommitSha: string | null;
  parentTreeSha: string | null;
  // Defaults to false. When true, this batch is "isolated" — it
  // never folds into another batch and another batch never folds
  // into it. Used by custom-message syncs so the user's typed
  // message survives intact and is never replaced by a group
  // template.
  isolated?: boolean;
};

export interface PushQueueDeps {
  vault: Vault;
  configDir: string;
  selfPluginId: string;
  // Override the clock for deterministic IDs in tests.
  now?: () => Date;
}

export default class PushQueue {
  private readonly vault: Vault;
  private readonly queueRoot: string;
  private readonly now: () => Date;
  // Serializes meta-file rewrites so concurrent `recordBlobUpload`
  // callers (parallel `createBlob` callbacks in TreeBuilder) don't
  // clobber each other's appends. Each call awaits the previous one
  // — overall throughput stays parallel for the network upload, only
  // the tiny meta-write turn is sequential.
  private metaWriteQueue: Promise<void> = Promise.resolve();

  constructor(deps: PushQueueDeps) {
    this.vault = deps.vault;
    this.queueRoot = `${deps.configDir}/plugins/${deps.selfPluginId}/${QUEUE_DIRNAME}`;
    this.now = deps.now ?? (() => new Date());
  }

  // Materialize a new batch on disk from `changes` and return its id.
  // Reads file contents from vault.adapter at this moment — the batch
  // is a snapshot of the user's intent at enqueue time, not a live
  // pointer.
  async enqueue(changes: FileChange[], meta: EnqueueMeta): Promise<string> {
    const id = await this.allocateUniqueId();
    await this.ensureDir(this.queueRoot);
    const batchDir = `${this.queueRoot}/${id}`;
    await this.ensureDir(batchDir);
    await this.ensureDir(`${batchDir}/${VAULT_SUBDIR}`);

    await this.writeMeta(batchDir, {
      commitMessage: meta.commitMessage,
      parentCommitSha: meta.parentCommitSha,
      parentTreeSha: meta.parentTreeSha,
      createdAt: Date.now(),
      isolated: meta.isolated ?? false,
    });

    const deletions: string[] = [];
    for (const c of changes) {
      if (c.kind === "deleted") {
        deletions.push(c.path);
        continue;
      }
      // added or modified: snapshot the current contents into the batch.
      await this.copyFileFromVault(c.path, batchDir);
    }
    if (deletions.length > 0) {
      await this.vault.adapter.write(
        `${batchDir}/${DELETIONS_FILE}`,
        deletions.join("\n") + "\n",
      );
    }
    return id;
  }

  // Return batch IDs oldest-first. Filters out non-batch entries so
  // stray dotfiles inside the queue root don't pollute the list.
  async list(): Promise<string[]> {
    if (!(await this.vault.adapter.exists(this.queueRoot))) return [];
    const { folders } = await this.vault.adapter.list(this.queueRoot);
    const ids = folders
      .map((f) => f.split("/").pop() ?? "")
      .filter((name) => /^\d{17}$/.test(name));
    ids.sort(); // lexicographic === chronological for this format
    return ids;
  }

  async read(id: string): Promise<QueueBatch> {
    const batchDir = `${this.queueRoot}/${id}`;
    const inProgress = await this.vault.adapter.exists(
      `${batchDir}/${IN_PROGRESS_FILE}`,
    );
    const attempted = await this.vault.adapter.exists(
      `${batchDir}/${ATTEMPTED_FILE}`,
    );
    const meta = await this.readMeta(batchDir);
    const files = await this.listVaultFiles(batchDir);
    const deletions = await this.readDeletions(batchDir);
    return {
      id,
      inProgress,
      attempted,
      commitMessage: meta.commitMessage,
      parentCommitSha: meta.parentCommitSha,
      parentTreeSha: meta.parentTreeSha,
      files,
      deletions,
      uploadedBlobs: meta.uploadedBlobs,
      isolated: meta.isolated,
    };
  }

  // Returns the union of every path mentioned in any queued batch
  // (any state — pending, in-progress, attempted). Used by
  // pullIfNeeded to identify which remote changes overlap with the
  // user's queued intent — those get deferred to push-time reconcile
  // instead of being applied directly to the live vault, because the
  // batch's snapshot is the source of truth for files the user
  // already clicked Sync on.
  async collectAllPaths(): Promise<Set<string>> {
    const out = new Set<string>();
    const ids = await this.list();
    for (const id of ids) {
      const batch = await this.read(id);
      for (const p of batch.files) out.add(p);
      for (const p of batch.deletions) out.add(p);
    }
    return out;
  }

  // Return the Git blob SHA of `path` as it sits in any queued batch
  // (any state — pending available, in-progress, attempted). Used by
  // ChangeDetector.findChanges to suppress duplicate enqueue when a
  // file the user "already committed locally" (= already snapshotted
  // into the queue) hasn't been mutated since: the batch will push
  // its content when its turn comes, no need to enqueue again.
  //
  // Resolution order per batch:
  //   1. If `uploadedBlobs[path]` exists, return it — that's the SHA
  //      GitHub already validated (the byte upload happened in a
  //      prior attempt). No disk read needed.
  //   2. Otherwise read `vault/<path>` from the batch directory and
  //      compute the Git blob SHA from those bytes.
  //
  // Returns the first match found across batches (oldest first, by
  // FIFO ordering — but since duplicates across batches are an
  // invariant we don't preserve, just the first match is enough).
  async peekPathSha(path: string): Promise<string | null> {
    const ids = await this.list();
    for (const id of ids) {
      const batchDir = `${this.queueRoot}/${id}`;
      const meta = await this.readMeta(batchDir);
      const cached = meta.uploadedBlobs[path];
      if (typeof cached === "string") return cached;
      const snapshotPath = `${batchDir}/${VAULT_SUBDIR}/${path}`;
      if (!(await this.vault.adapter.exists(snapshotPath))) continue;
      const buf = await this.vault.adapter.readBinary(snapshotPath);
      return await calculateGitBlobSHA(buf);
    }
    return null;
  }

  // Record that `createBlob` succeeded for `path` in this batch.
  // Serialized through metaWriteQueue so concurrent callers (parallel
  // createBlob callbacks in TreeBuilder) can't clobber each other's
  // entries. On resume of an interrupted batch, TreeBuilder consults
  // this map BEFORE issuing createBlob — present paths skip the
  // network call entirely, the cached SHA goes straight into the
  // tree entry.
  async recordBlobUpload(
    id: string,
    path: string,
    sha: string,
  ): Promise<void> {
    const next = this.metaWriteQueue.then(async () => {
      const batchDir = `${this.queueRoot}/${id}`;
      const meta = await this.readMeta(batchDir);
      const updated = { ...meta.uploadedBlobs, [path]: sha };
      await this.writeMeta(batchDir, {
        commitMessage: meta.commitMessage,
        parentCommitSha: meta.parentCommitSha,
        parentTreeSha: meta.parentTreeSha,
        createdAt: meta.createdAt,
        uploadedBlobs: updated,
      });
    });
    // Swallow errors on the chained queue value (so one failure
    // doesn't poison every subsequent enqueue) but propagate this
    // call's own outcome to its caller.
    this.metaWriteQueue = next.catch(() => undefined);
    return next;
  }

  async markInProgress(id: string): Promise<void> {
    const batchDir = `${this.queueRoot}/${id}`;
    await this.vault.adapter.write(`${batchDir}/${IN_PROGRESS_FILE}`, "");
  }

  // Mark this batch as "ever attempted" — call exactly once,
  // typically right after markInProgress at the start of processBatch.
  // The presence of this file freezes the batch against further
  // mergeIntoLatestPending calls, modelling "in-progress OR failed
  // is blocked from merges". The marker is only removed when the
  // whole batch dir is deleted (commit success).
  async markAttempted(id: string): Promise<void> {
    const batchDir = `${this.queueRoot}/${id}`;
    const markerPath = `${batchDir}/${ATTEMPTED_FILE}`;
    if (await this.vault.adapter.exists(markerPath)) return;
    await this.vault.adapter.write(markerPath, "");
  }

  async clearInProgress(id: string): Promise<void> {
    const path = `${this.queueRoot}/${id}/${IN_PROGRESS_FILE}`;
    if (await this.vault.adapter.exists(path)) {
      await this.vault.adapter.remove(path);
    }
  }

  async delete(id: string): Promise<void> {
    const batchDir = `${this.queueRoot}/${id}`;
    if (!(await this.vault.adapter.exists(batchDir))) return;
    // adapter.rmdir(path, recursive) is Obsidian's native operation
    // for "delete this folder and everything in it". Hand-rolling a
    // walk would needlessly fight Obsidian's FS abstraction.
    await this.vault.adapter.rmdir(batchDir, true);
  }

  // Drop every batch on disk. Used by Sync2Manager when it detects
  // the user pointed the plugin at a different remote — the pending
  // batches reference the previous repo's parent SHAs and would push
  // wrong content. Also used by the "Reset" settings button.
  async clearAll(): Promise<void> {
    if (!(await this.vault.adapter.exists(this.queueRoot))) return;
    await this.vault.adapter.rmdir(this.queueRoot, true);
  }

  // Append `changes` into the most recent pending (not in-progress)
  // batch. Used by the offline-accumulate path so a streak of Sync
  // clicks while disconnected coalesces into a single commit. Returns
  // the batch id that received the changes, or null if no pending
  // batch exists (caller should enqueue() instead).
  async mergeIntoLatestPending(
    changes: FileChange[],
  ): Promise<string | null> {
    const ids = await this.list();
    let target: string | null = null;
    for (let i = ids.length - 1; i >= 0; i--) {
      const batchDir = `${this.queueRoot}/${ids[i]}`;
      const inProg = await this.vault.adapter.exists(
        `${batchDir}/${IN_PROGRESS_FILE}`,
      );
      if (inProg) continue;
      const attempted = await this.vault.adapter.exists(
        `${batchDir}/${ATTEMPTED_FILE}`,
      );
      if (attempted) continue;
      // Isolated batches (custom-message commits) keep their message
      // intact and refuse to fold new changes in. Skip and keep
      // looking; if none is mergeable, caller falls back to enqueue.
      const meta = await this.readMeta(batchDir);
      if (meta.isolated) continue;
      target = ids[i];
      break;
    }
    if (target === null) return null;

    const batchDir = `${this.queueRoot}/${target}`;
    const existingDeletions = new Set(await this.readDeletions(batchDir));
    for (const c of changes) {
      if (c.kind === "deleted") {
        existingDeletions.add(c.path);
        // If we previously snapshotted this file in the batch, remove
        // it — the new intent is "delete", not "upload".
        await this.removeBatchFile(batchDir, c.path);
        continue;
      }
      // Upload-style change: re-snapshot from vault, overwriting any
      // earlier snapshot of the same path in this batch.
      existingDeletions.delete(c.path);
      await this.copyFileFromVault(c.path, batchDir);
    }
    if (existingDeletions.size > 0) {
      await this.vault.adapter.write(
        `${batchDir}/${DELETIONS_FILE}`,
        [...existingDeletions].join("\n") + "\n",
      );
    } else if (
      await this.vault.adapter.exists(`${batchDir}/${DELETIONS_FILE}`)
    ) {
      await this.vault.adapter.remove(`${batchDir}/${DELETIONS_FILE}`);
    }
    return target;
  }

  // Update parent SHAs in an existing batch's .meta.json. Used after
  // remote-side reconciliation: the batch was originally enqueued
  // against expectedHead, but by the time we push the head moved, so
  // the commit is built on currentHead instead. Only the parent
  // pointers and base_tree change; commitMessage stays.
  async updateMeta(
    id: string,
    patch: { parentCommitSha?: string | null; parentTreeSha?: string | null },
  ): Promise<void> {
    const batchDir = `${this.queueRoot}/${id}`;
    const text = await this.vault.adapter.read(`${batchDir}/${META_FILE}`);
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (patch.parentCommitSha !== undefined) {
      raw.parentCommitSha = patch.parentCommitSha;
    }
    if (patch.parentTreeSha !== undefined) {
      raw.parentTreeSha = patch.parentTreeSha;
    }
    await this.vault.adapter.write(
      `${batchDir}/${META_FILE}`,
      JSON.stringify(raw),
    );
  }

  // Replace the batch's commit message in .meta.json. Used by
  // enqueueOrMerge after a successful accumulate-merge: the
  // "accumulate group" should commit with the message of the LAST
  // (most recent) sync click rather than the first, so the
  // timestamp on GitHub reflects when the batch actually pushed.
  // Routed through the same metaWriteQueue as recordBlobUpload so
  // concurrent writers don't clobber each other.
  async updateCommitMessage(
    id: string,
    commitMessage: string,
  ): Promise<void> {
    const next = this.metaWriteQueue.then(async () => {
      const batchDir = `${this.queueRoot}/${id}`;
      const meta = await this.readMeta(batchDir);
      await this.writeMeta(batchDir, {
        ...meta,
        commitMessage,
      });
    });
    this.metaWriteQueue = next.catch(() => undefined);
    return next;
  }

  // Read a single file's bytes from inside the batch's vault/ snapshot.
  // Used by Sync2Manager during conflict reconciliation to obtain the
  // "ours" side for a 3-way merge.
  async readFile(id: string, vaultPath: string): Promise<ArrayBuffer> {
    const target = `${this.queueRoot}/${id}/${VAULT_SUBDIR}/${vaultPath}`;
    return await this.vault.adapter.readBinary(target);
  }

  // Replace a single file's content inside an existing batch. Used by
  // cascading conflict resolution: when batch Q1's resolve produces a
  // new version, later batches that touch the same path are rebased
  // against it before pushing.
  // Remove a single path from a batch's snapshot. Used by reconcile
  // when the user defers a conflict mid-push: the path drops out of
  // this batch's push (ConflictStore takes over until the user
  // resolves the sibling), and the rest of the batch proceeds.
  async removeFile(id: string, path: string): Promise<void> {
    await this.removeBatchFile(`${this.queueRoot}/${id}`, path);
  }

  async overwriteFile(
    id: string,
    path: string,
    content: ArrayBuffer,
  ): Promise<void> {
    const batchDir = `${this.queueRoot}/${id}`;
    const targetPath = `${batchDir}/${VAULT_SUBDIR}/${path}`;
    await this.ensureParentDir(targetPath);
    if (hasTextExtension(path)) {
      // Caller (Sync2Manager during cascade-rebase) hands us merged text
      // from a 3-way merge. Inputs to that merge come through the same
      // normalizeText pipeline, so the merge output is usually canonical
      // already — but normalize here as a safety net so the snapshot
      // never stores non-canonical bytes regardless of caller hygiene.
      const text = new TextDecoder().decode(content);
      const { content: normalized } = normalizeText(text);
      await this.vault.adapter.write(targetPath, normalized);
    } else {
      await this.vault.adapter.writeBinary(targetPath, content);
    }
  }

  // ── internal helpers ────────────────────────────────────────────────

  private async allocateUniqueId(): Promise<string> {
    // The mock filesystem can produce identical IDs when two enqueues
    // land in the same millisecond. Bump the trailing millisecond
    // counter until the directory doesn't exist yet.
    let id = newBatchId(this.now());
    while (
      await this.vault.adapter.exists(`${this.queueRoot}/${id}`)
    ) {
      // Tick forward a millisecond. Keeps total ordering monotonic.
      const next = new Date(parseTimestampId(id) + 1);
      id = newBatchId(next);
    }
    return id;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    if (!(await this.vault.adapter.exists(dirPath))) {
      await this.vault.adapter.mkdir(dirPath);
    }
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const parent = filePath.substring(0, slash);
    if (await this.vault.adapter.exists(parent)) return;
    // adapter.mkdir is non-recursive on some platforms; build the path
    // a segment at a time.
    const parts = parent.split("/");
    let acc = "";
    for (const part of parts) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
  }

  private async copyFileFromVault(
    vaultPath: string,
    batchDir: string,
  ): Promise<void> {
    const target = `${batchDir}/${VAULT_SUBDIR}/${vaultPath}`;
    await this.ensureParentDir(target);
    if (hasTextExtension(vaultPath)) {
      // Text canonicalisation (Etap 6.6). Read live bytes, normalize to
      // LF + no-BOM + trailing-NL-iff-non-empty. The snapshot stores the
      // canonical form so TreeBuilder uploads canonical bytes to GitHub.
      // Write-back to the live vault file enforces the "локально все
      // правильно" invariant, but only when something actually changed
      // — touching the vault file on every Sync click would needlessly
      // bump mtime and disturb ChangeDetector's stat-cache shortcut.
      const original = await this.vault.adapter.read(vaultPath);
      const { content, changed } = normalizeText(original);
      if (changed) {
        await this.vault.adapter.write(vaultPath, content);
      }
      await this.vault.adapter.write(target, content);
    } else {
      const buf = await this.vault.adapter.readBinary(vaultPath);
      await this.vault.adapter.writeBinary(target, buf);
    }
  }

  private async removeBatchFile(
    batchDir: string,
    vaultPath: string,
  ): Promise<void> {
    const target = `${batchDir}/${VAULT_SUBDIR}/${vaultPath}`;
    if (await this.vault.adapter.exists(target)) {
      await this.vault.adapter.remove(target);
    }
  }

  private async writeMeta(
    batchDir: string,
    meta: {
      commitMessage: string;
      parentCommitSha: string | null;
      parentTreeSha: string | null;
      createdAt: number;
      uploadedBlobs?: Record<string, string>;
      isolated?: boolean;
    },
  ): Promise<void> {
    const out = {
      ...meta,
      uploadedBlobs: meta.uploadedBlobs ?? {},
      isolated: meta.isolated ?? false,
    };
    await this.vault.adapter.write(
      `${batchDir}/${META_FILE}`,
      JSON.stringify(out),
    );
  }

  private async readMeta(batchDir: string): Promise<{
    commitMessage: string;
    parentCommitSha: string | null;
    parentTreeSha: string | null;
    createdAt: number;
    uploadedBlobs: Record<string, string>;
    isolated: boolean;
  }> {
    const text = await this.vault.adapter.read(`${batchDir}/${META_FILE}`);
    const raw = JSON.parse(text) as Record<string, unknown>;
    let uploadedBlobs: Record<string, string> = {};
    if (raw.uploadedBlobs && typeof raw.uploadedBlobs === "object") {
      // Coerce to Record<string, string>, dropping any non-string
      // entries silently. Pre-existing batches written before this
      // field landed deserialize with the empty default.
      const candidate = raw.uploadedBlobs as Record<string, unknown>;
      for (const [path, sha] of Object.entries(candidate)) {
        if (typeof sha === "string") uploadedBlobs[path] = sha;
      }
    }
    return {
      commitMessage:
        typeof raw.commitMessage === "string" ? raw.commitMessage : "",
      parentCommitSha:
        typeof raw.parentCommitSha === "string" ? raw.parentCommitSha : null,
      parentTreeSha:
        typeof raw.parentTreeSha === "string" ? raw.parentTreeSha : null,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
      uploadedBlobs,
      isolated: raw.isolated === true,
    };
  }

  private async readDeletions(batchDir: string): Promise<string[]> {
    const file = `${batchDir}/${DELETIONS_FILE}`;
    if (!(await this.vault.adapter.exists(file))) return [];
    const text = await this.vault.adapter.read(file);
    return text.split("\n").filter((line) => line.length > 0);
  }

  private async listVaultFiles(batchDir: string): Promise<string[]> {
    const root = `${batchDir}/${VAULT_SUBDIR}`;
    if (!(await this.vault.adapter.exists(root))) return [];
    const out: string[] = [];
    const walk = async (dir: string) => {
      const { files, folders } = await this.vault.adapter.list(dir);
      for (const f of files) out.push(f.slice(root.length + 1));
      for (const sub of folders) await walk(sub);
    };
    await walk(root);
    return out;
  }

}

function parseTimestampId(id: string): number {
  // "YYYYMMDDhhmmssfff" → ms epoch (UTC).
  const y = parseInt(id.slice(0, 4), 10);
  const mo = parseInt(id.slice(4, 6), 10) - 1;
  const d = parseInt(id.slice(6, 8), 10);
  const h = parseInt(id.slice(8, 10), 10);
  const mi = parseInt(id.slice(10, 12), 10);
  const s = parseInt(id.slice(12, 14), 10);
  const ms = parseInt(id.slice(14, 17), 10);
  return Date.UTC(y, mo, d, h, mi, s, ms);
}
