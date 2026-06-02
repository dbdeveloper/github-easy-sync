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

// Queue-cap flush trigger (§2.8 trigger 3). Idle/nav timers (triggers 1/2) and
// the explicit pre-exit flush (trigger 4) are caller-driven in Phase 6.
export const QUEUE_CAP = 10;

export class HistoryWriter {
  private seq = 0;
  private queue: string[] = [];

  constructor(
    private readonly vault: Vault,
    private readonly autosaveId: string,
  ) {}

  private path(): string {
    return `${autosaveDir(this.autosaveId)}/history.jsonl`;
  }

  // Queue one transaction's block. Auto-flushes when the queue hits QUEUE_CAP.
  async record(change: unknown, structure: Segment[], at: string): Promise<void> {
    this.seq += 1;
    this.queue.push(serializeHistoryBlock(this.seq, at, change, structure));
    if (this.queue.length >= QUEUE_CAP) await this.flush();
  }

  // Append all queued blocks as one NDJSON write (§2.7 — adapter.append is
  // mobile-proven via src/logger.ts). No-op when the queue is empty.
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const data = this.queue.map((line) => `${line}\n`).join("");
    this.queue = [];
    await this.vault.adapter.append(this.path(), data);
  }

  pendingCount(): number {
    return this.queue.length;
  }

  currentSeq(): number {
    return this.seq;
  }
}
