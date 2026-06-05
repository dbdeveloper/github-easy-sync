// Stage 3a — the persistent REDO-log: `history.jsonl` block format + writer
// (DIFF-EDITOR.md §2.6 / §2.7 / §2.8).
//
// Append-only NDJSON: one CM6 transaction = one block = one line (§2.3). Each
// block carries the post-transaction `Segment[]` structure (format B — the
// gate spike proved ChangeSet-only can't reconstruct Rep-A roles on replay;
// see history-replay-structure-spike + §2.6 reconciliation). Replay (§3.3,
// Stage 3b) sets that structure directly via setDiffPaneState, so it's a pure
// function of the log.
//
// SCOPE (tested core): block (de)serialization + checksum, and a coalesce
// writer with explicit flush + queue-cap auto-flush. The real idle/nav timers
// (§2.8 triggers 1/2) and the CM6 transaction listener that feeds record() are
// Phase-6 wiring — but the replay opt-out marker lives here so that's wireable.

import { Annotation } from "@codemirror/state";
import type { Vault } from "obsidian";
import { autosaveDir } from "./autosave-store";
import type { Segment } from "./editor-model";

// ── checksum (§2.6 `sum`) ────────────────────────────────────────────

// FNV-1a 32-bit over UTF-8 bytes, 8 lowercase hex. NOT crypto — a torn-write /
// bit-rot tripwire. Math.imul makes the 32-bit multiply exact (a plain `*`
// would lose precision past 2^53). Pinned to published FNV-1a-32 vectors in
// history-log.test.ts.
export function fnv1a32(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ── block format (§2.6) ──────────────────────────────────────────────

export interface HistoryBlock {
  seq: number; // monotonic from 1 (diagnostics; replay is linear)
  at: string; // ISO timestamp of the transaction
  change: unknown; // ChangeSet.toJSON()
  structure: Segment[]; // post-tx structure (format B)
  sum: string; // fnv1a32 over the checksum payload
}

// ONE serializer used at BOTH write and verify, so the bytes the checksum
// covers are byte-identical across a parse round-trip (the classic torn-write-
// detector trap). Covers `change` AND `structure` — both drive replay.
function checksumPayload(change: unknown, structure: Segment[]): string {
  return JSON.stringify({ change, structure });
}

export function serializeHistoryBlock(
  seq: number,
  at: string,
  change: unknown,
  structure: Segment[],
): string {
  const sum = fnv1a32(checksumPayload(change, structure));
  return JSON.stringify({ seq, at, change, structure, sum });
}

// Parse one NDJSON line. Returns null for blank/corrupt lines or wrong shape —
// replay treats null as "stop here" (§3.3 step 4b).
export function parseHistoryBlock(line: string): HistoryBlock | null {
  const t = line.trim();
  if (t === "") return null;
  try {
    const o = JSON.parse(t) as Partial<HistoryBlock>;
    if (
      typeof o.seq !== "number" ||
      typeof o.at !== "string" ||
      typeof o.sum !== "string" ||
      !Array.isArray(o.structure) ||
      o.change === undefined
    ) {
      return null;
    }
    return o as HistoryBlock;
  } catch {
    return null;
  }
}

// True iff the block's recorded sum matches a fresh recompute (§3.3 step 4c).
export function verifyHistoryBlock(b: HistoryBlock): boolean {
  return fnv1a32(checksumPayload(b.change, b.structure)) === b.sum;
}

// ── replay opt-out marker (Phase-6 wireability) ──────────────────────

// The Phase-6 CM6 transaction listener that feeds HistoryWriter.record() MUST
// skip transactions carrying this annotation — otherwise resuming a session
// (which replays via view.dispatch) would re-append every restored edit and
// double the log. Dispatch replayed transactions with
// `annotations: replayDispatch.of(true)`.
export const replayDispatch = Annotation.define<boolean>();

// ── coalesce writer (§2.7 append, §2.8 queue) ────────────────────────

export class HistoryWriter {
  // Monotonic `seq:` stamp for the block field — NEVER decremented (diagnostics /
  // tooling; replay is position-ordered, not seq-ordered, so a gap after an
  // undo+edit is harmless). Distinct from `blockCount` below.
  private stamp: number;
  // LIVE on-disk block count == the editor's CM6 undo depth (TODO §5). record()
  // increments it; truncateLastBlock() (a CM6 undo) decrements it. This — NOT the
  // stamp — is what `liveBlockCount()` returns, so §4.1.a exit-wipe sees a true
  // net-edit count (N edits then N undos → 0 → discard, inputs untouched).
  private blockCount: number;
  private queue: string[] = [];
  // Serialized append chain — flushes (and truncates) run one-at-a-time so two
  // concurrent adapter writes to history.jsonl can't interleave or clobber (§2.7;
  // Capacitor gives no cross-call ordering). The enqueue half of record() is
  // synchronous, so block order is fixed before any await.
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly vault: Vault,
    private readonly autosaveId: string,
    // Resume-Continue reuses the SAME history.jsonl (KEEP dir) — continue from
    // the replayed block count so both the stamp stays monotonic AND blockCount
    // matches the on-disk prefix the user can undo back into. Fresh / recreated
    // sessions start at 0. (§3.2 / W2.)
    startSeq = 0,
  ) {
    this.stamp = startSeq;
    this.blockCount = startSeq;
  }

  private path(): string {
    return `${autosaveDir(this.autosaveId)}/history.jsonl`;
  }

  // Record one transaction's block. stamp/blockCount++ + enqueue are SYNCHRONOUS
  // (ordering guaranteed); the append is scheduled on the serialized tail chain.
  // Burst edits during one in-flight append coalesce into the next flush. §2.8
  // (append per transaction, no coalesce window).
  record(change: unknown, structure: Segment[], at: string): void {
    this.stamp += 1;
    this.blockCount += 1;
    this.queue.push(serializeHistoryBlock(this.stamp, at, change, structure));
    this.tail = this.tail.then(() => this.flush()).catch((e) => {
      // A failed append loses this one increment; the session snapshots + prior
      // history + the [← back] Step-1 drain are the backstop. NEVER propagate
      // into CM6's update cycle.
      console.error("[gh-sync] diff2 history append failed", e);
    });
  }

  // TODO §5 — a CM6 undo drops the last REDO-block so history.jsonl always
  // mirrors the editor's done-stack (block count == undoDepth). Without this,
  // replay re-applies undone changes (the log grows unbounded on undo/redo
  // cycling) and the net edit-count feeding §4.1.a exit-wipe / the recovery
  // dialog's "N edits" is wrong. blockCount is decremented SYNCHRONOUSLY (so an
  // immediate exit reads the right count); the file rewrite is scheduled on the
  // serialized tail AFTER any pending append, so it reads a complete file. Plain
  // adapter.write — a torn rewrite leaves a clean prefix scanHistory stops at,
  // and a fully-failed truncate degrades to "block not removed" (today's
  // behaviour), so no temp+rename atomicity is needed (which would also litter
  // the autosave dir with .sync-tmp that the recovery scanners walk).
  truncateLastBlock(): void {
    if (this.blockCount > 0) this.blockCount -= 1;
    // Queue-aware: if the last recorded block is STILL queued (not yet flushed to
    // disk), just drop it from the queue — no file op, and crucially no race with
    // a pending flush that would otherwise write the block we're undoing. (In
    // real use each transaction is a separate event-loop tick so the queue is
    // empty here; but a record→undo→record burst in one tick must stay correct,
    // and `blockCount` must equal disk-blocks + queued-blocks at all times.)
    if (this.queue.length > 0) {
      this.queue.pop();
      return;
    }
    // The block is already on disk → drop the last line. Scheduled on the tail
    // AFTER prior flushes, BEFORE later records' flushes (do NOT flush here: that
    // would write a later-record's queued block, then truncate the wrong line).
    this.tail = this.tail.then(() => this.doTruncate()).catch((e) => {
      console.error("[gh-sync] diff2 history truncate failed", e);
    });
  }

  private async doTruncate(): Promise<void> {
    const p = this.path();
    if (!(await this.vault.adapter.exists(p))) return;
    const content = await this.vault.adapter.read(p);
    // Each block is ONE `<json>\n` line (NDJSON), so dropping the last block is a
    // single CUT — no parsing. Find the newline that terminates the SECOND-to-last
    // block (i.e. the last `\n` before the trailing one) and keep everything up to
    // and including it; one `slice`, no per-line allocation. Last block → "".
    // (`read` is whole-file — Obsidian has no partial read; that's the API floor.)
    const cut = content.lastIndexOf("\n", content.length - 2);
    await this.vault.adapter.write(p, cut < 0 ? "" : content.slice(0, cut + 1));
  }

  // Append all queued blocks as one NDJSON write (§2.7 — adapter.append is
  // mobile-proven via src/logger.ts). No-op when the queue is empty.
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const data = this.queue.map((line) => `${line}\n`).join("");
    this.queue = [];
    await this.vault.adapter.append(this.path(), data);
  }

  // Await every scheduled append/truncate — the [← back] Step-1 flush barrier.
  async drain(): Promise<void> {
    await this.tail;
    await this.flush();
  }

  pendingCount(): number {
    return this.queue.length;
  }

  // The LIVE net-edit count (== CM6 undo depth), NOT the monotonic stamp. Feeds
  // §4.1.a exit-wipe / disposeActiveDiffPane.
  liveBlockCount(): number {
    return this.blockCount;
  }
}
