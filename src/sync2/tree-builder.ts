// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { arrayBufferToBase64, Vault } from "obsidian";
import { NewTreeRequestItem } from "../github/client";
import { hasTextExtension } from "../utils";
import PushQueue from "./push-queue";
import { QueueBatch } from "./types";

// Minimal client surface TreeBuilder needs. Lets tests inject a stub
// without dragging the full GithubClient (which carries settings,
// retries, etc. that are irrelevant here).
export interface TreeBuilderClient {
  createBlob(args: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
  }): Promise<{ sha: string }>;
}

const VAULT_SUBDIR = "vault";
const QUEUE_DIRNAME = ".push-queue";

export interface TreeBuilderDeps {
  vault: Vault;
  queue: PushQueue;
  client: TreeBuilderClient;
  configDir: string;
  selfPluginId: string;
}

export default class TreeBuilder {
  private readonly vault: Vault;
  private readonly queue: PushQueue;
  private readonly client: TreeBuilderClient;
  private readonly queueRoot: string;

  constructor(deps: TreeBuilderDeps) {
    this.vault = deps.vault;
    this.queue = deps.queue;
    this.client = deps.client;
    this.queueRoot = `${deps.configDir}/plugins/${deps.selfPluginId}/${QUEUE_DIRNAME}`;
  }

  // Turn a queued batch into the tree[] array for createTree, plus the
  // base_tree SHA the caller should pair with it. Caller is expected
  // to feed the result straight into client.createTree({ tree: entries,
  // base_tree }) and then build a commit on top.
  //
  // Files come from the batch's vault/ subdirectory, NOT from the live
  // vault — the batch represents the user's intent at enqueue time and
  // must not be re-read against current disk state.
  //
  // `hooks` are optional progress callbacks for the UI.
  // `onUploadStart(total)` fires once before any file is processed
  // (caller can show "0/N files"); `onFileProcessed(done, total)`
  // fires after every file passes through the builder — text files
  // count too, because the user thinks in terms of total files
  // shipping to GitHub, not in terms of "blob round-trips happened".
  // Both hooks are skipped when the batch is delete-only (no files
  // to upload at all).
  async buildTreeEntries(
    batchId: string,
    hooks?: {
      onUploadStart?: (totalFiles: number) => void;
      onFileProcessed?: (processed: number, total: number) => void;
    },
  ): Promise<{ entries: NewTreeRequestItem[]; baseTreeSha: string | null; batch: QueueBatch }> {
    const batch = await this.queue.read(batchId);
    const batchVaultDir = `${this.queueRoot}/${batchId}/${VAULT_SUBDIR}`;

    // Group by handling: text files inline content; binary files need
    // a createBlob round-trip first; deletions just set sha: null.
    const textFiles: string[] = [];
    const binaryFiles: string[] = [];
    for (const path of batch.files) {
      if (hasTextExtension(path)) textFiles.push(path);
      else binaryFiles.push(path);
    }

    const entries: NewTreeRequestItem[] = [];
    const totalFiles = textFiles.length + binaryFiles.length;
    if (totalFiles > 0) hooks?.onUploadStart?.(totalFiles);
    let processed = 0;
    const tickProgress = (): void => {
      processed += 1;
      hooks?.onFileProcessed?.(processed, totalFiles);
    };

    // Text files: read once, inline as `content`. GitHub stores it as
    // the blob; we never touch createBlob for these.
    for (const path of textFiles) {
      const content = await this.vault.adapter.read(
        `${batchVaultDir}/${path}`,
      );
      entries.push({
        path,
        mode: "100644",
        type: "blob",
        content,
      });
      tickProgress();
    }

    // Binary files: createBlob in parallel for throughput. Each call
    // returns a blob SHA; the tree entry references it. Concurrency
    // is bounded by Promise.allSettled (one per file) — fine on the
    // small batches sync2 produces (single Sync click, 1–10 files
    // typical).
    //
    // Resume optimisation: `batch.uploadedBlobs` holds path→SHA pairs
    // from prior crashed attempts at this batch. Each map hit skips
    // the entire createBlob round-trip — the recorded SHA goes
    // straight into the tree entry. Misses upload as normal, then
    // persist via `recordBlobUpload` so the next resume sees them.
    // The metaWriteQueue inside PushQueue serializes those persists
    // so parallel callbacks don't clobber each other.
    //
    // We use allSettled rather than `Promise.all` so a single failure
    // doesn't abandon sibling callbacks while their createBlob+
    // recordBlobUpload are still mid-flight — that race would leave
    // uploadedBlobs out of sync with the actual GitHub-side blob set
    // and break resume. With allSettled, every sibling either lands
    // its recordBlobUpload or fails cleanly before we re-throw the
    // first error.
    const settled = await Promise.allSettled(
      binaryFiles.map(async (path) => {
        const cachedSha = batch.uploadedBlobs[path];
        if (typeof cachedSha === "string") {
          tickProgress();
          return {
            path,
            mode: "100644",
            type: "blob",
            sha: cachedSha,
          } satisfies NewTreeRequestItem;
        }
        const buf = await this.vault.adapter.readBinary(
          `${batchVaultDir}/${path}`,
        );
        const blob = await this.client.createBlob({
          content: arrayBufferToBase64(buf),
          encoding: "base64",
          retry: true,
        });
        await this.queue.recordBlobUpload(batchId, path, blob.sha);
        tickProgress();
        return {
          path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        } satisfies NewTreeRequestItem;
      }),
    );
    const firstReject = settled.find((r) => r.status === "rejected");
    if (firstReject && firstReject.status === "rejected") {
      throw firstReject.reason;
    }
    for (const r of settled) {
      if (r.status === "fulfilled") entries.push(r.value);
    }

    // Deletions: per GitHub's tree API, omit content+sha and explicitly
    // set sha to null. The server interprets this as "remove this path
    // from the tree".
    for (const path of batch.deletions) {
      entries.push({
        path,
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }

    return {
      entries,
      baseTreeSha: batch.parentTreeSha,
      batch,
    };
  }
}
