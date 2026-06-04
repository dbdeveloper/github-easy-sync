// Stage 3b / W3 — cursor persistence, 2-slot ping-pong (DIFF-EDITOR.md §2.9).
//
// Cursor position lives in its OWN file (NOT in history.jsonl): edits are
// append-only and tied to MODIFICATIONS, but ~80% of a session is navigation,
// where the caret moves without any history block. So cursor is a separate,
// timer-rewritten file (the timer/cadence lives in cursor-timer.ts + the view).
//
// §2.9 RATIFIED design — **2-slot ping-pong** instead of atomic temp+rename
// (rename p95≈28ms + a zero-cursor window between unlink and rename):
//   - two slots `cursor-a.json` / `cursor-b.json`, each carrying a monotonic
//     `seq`. startSession writes `cursor-a.json` (seq 0).
//   - persistCursor reads BOTH, writes the LOWER-seq (stale) slot with seq =
//     max+1 via a PLAIN `adapter.write` (~3ms). The plain write is crash-safe
//     PRECISELY because the OTHER (max-seq) slot is never touched — it is the
//     recovery fallback, so a torn write of the stale slot loses nothing.
//   - readCursor (recovery) picks the slot with the highest VALID seq; a torn
//     slot fails to parse and the other (lower-seq, intact) slot wins.

import type { Vault } from "obsidian";
// Slot path + type live in autosave-store (the home of every session-file path
// helper — metaPath/historyPath/snapshotPaths), so the naming has ONE source
// and there is no autosave-store ⇄ cursor-store import cycle.
import { cursorSlotPath, type CursorSlot } from "./autosave-store";

export interface CursorState {
  v: 1;
  seq: number; // monotonic per session; recovery picks the max valid seq
  anchor: number; // selection.main.anchor
  head: number; // selection.main.head (== anchor for a plain caret)
  scrollTop: number; // optional UX bonus; recovery works without it
  savedAt: string; // ISO timestamp of the last timer-flush (diagnostics)
}

// Read one slot → validated CursorState, or null on missing / corrupt /
// wrong-shape (a torn ping-pong write lands here and is discarded). seq is
// validated with `typeof === "number"` so a fresh slot's `seq: 0` is accepted
// (a truthiness check would wrongly reject it).
async function readSlot(
  vault: Vault,
  conflictId: string,
  slot: CursorSlot,
): Promise<CursorState | null> {
  const p = cursorSlotPath(conflictId, slot);
  if (!(await vault.adapter.exists(p))) return null;
  try {
    const o = JSON.parse(await vault.adapter.read(p)) as Partial<CursorState>;
    if (
      typeof o.anchor !== "number" ||
      typeof o.head !== "number" ||
      typeof o.seq !== "number"
    ) {
      return null;
    }
    return {
      v: 1,
      seq: o.seq,
      anchor: o.anchor,
      head: o.head,
      scrollTop: typeof o.scrollTop === "number" ? o.scrollTop : 0,
      savedAt: typeof o.savedAt === "string" ? o.savedAt : "",
    };
  } catch {
    return null; // corrupt / torn → skip this slot
  }
}

// Ping-pong write. Reads both slots, writes the STALE (lower-seq) one with the
// next seq via a plain adapter.write. `nowIso` injectable for tests.
//
// ⚠ CRASH-SAFETY INVARIANT: we write the LOWER-seq slot and NEVER the max-seq
// slot. The max-seq slot is the recovery fallback (readCursor picks it); a plain
// (non-atomic) write is only safe because that fallback stays intact. Do not
// "optimize" the slot selection without preserving this — `cursor-store.test.ts`
// asserts the max-seq slot is never the one written.
export async function persistCursor(
  vault: Vault,
  conflictId: string,
  pos: { anchor: number; head: number; scrollTop?: number },
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  const a = await readSlot(vault, conflictId, "a");
  const b = await readSlot(vault, conflictId, "b");
  const seqA = a?.seq ?? -1;
  const seqB = b?.seq ?? -1;
  // Write the lower-seq slot (ties → "a"); the higher-seq slot is the fallback.
  const target: CursorSlot = seqA <= seqB ? "a" : "b";
  const state: CursorState = {
    v: 1,
    seq: Math.max(seqA, seqB) + 1,
    anchor: pos.anchor,
    head: pos.head,
    scrollTop: pos.scrollTop ?? 0,
    savedAt: nowIso,
  };
  await vault.adapter.write(
    cursorSlotPath(conflictId, target),
    JSON.stringify(state),
  );
}

// Recovery read — the slot with the highest VALID seq (a torn slot parses to
// null and loses). Returns null only when BOTH slots are missing/corrupt;
// recovery then skips applying a selection and lets CM6 place the caret
// naturally (§2.9 / §3.5 fallback).
export async function readCursor(
  vault: Vault,
  conflictId: string,
): Promise<CursorState | null> {
  const a = await readSlot(vault, conflictId, "a");
  const b = await readSlot(vault, conflictId, "b");
  if (!a && !b) return null;
  return (a?.seq ?? -1) >= (b?.seq ?? -1) ? a : b;
}

// Clamp anchor/head into [0, docLength] (§2.9 / §3.3 step 7c-d) — the document
// may have SHRUNK during history replay, so a stored offset can exceed it.
export function clampCursor(
  cursor: Pick<CursorState, "anchor" | "head">,
  docLength: number,
): { anchor: number; head: number } {
  const clamp = (x: number): number => (x < 0 ? 0 : x > docLength ? docLength : x);
  return { anchor: clamp(cursor.anchor), head: clamp(cursor.head) };
}
