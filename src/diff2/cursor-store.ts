// Stage 3b — cursor.json persistence (DIFF-EDITOR.md §2.9).
//
// Cursor position lives in its own file (NOT in history.jsonl): edits are
// append-only and tied to MODIFICATIONS, but ~80% of a session is navigation,
// where the caret moves without any history block. So cursor is a separate,
// timer-rewritten file. startSession (§2.5.a) creates it; this module rewrites
// it and reads it back on recovery.
//
// ⚠ SPEC DRIFT — REWRITE AT W3: §2.9 was RATIFIED (2026-06-04) to the
// **2-slot ping-pong** (`cursor-a.json` / `cursor-b.json`, each with a
// monotonic `seq`; write the stale slot via plain `adapter.write` ≈3ms,
// recover by max valid `seq`). This module is still the PRE-decision atomic
// temp+rename single-file (`cursor.json`, p95≈28ms). It is greenfield (not yet
// wired — W3 adds the timer), so the rewrite lands with W3; until then code and
// §2.9 intentionally differ. The W3 rewrite also touches the contract:
// startSession (writes `cursor-a.json` seq 0), classifySweep §4.2 cond-3 (check
// `cursor-a.json` OR `cursor-b.json`), and this module's read (max-seq slot).
//
// SCOPE (tested core): persist / read / clamp. The active-typing (2500 ms) vs
// navigation (6000 ms) debounce timer that DECIDES when to call persistCursor is
// caller-driven (W3 — real timers).

import type { Vault } from "obsidian";
import { safeRename } from "../sync2/cross-platform";
import { autosaveDir } from "./autosave-store";

export interface CursorState {
  v: 1;
  anchor: number; // selection.main.anchor
  head: number; // selection.main.head (== anchor for a plain caret)
  scrollTop: number; // optional UX bonus; recovery works without it
  savedAt: string; // ISO timestamp of the last timer-flush (diagnostics)
}

const cursorPath = (id: string): string => `${autosaveDir(id)}/cursor.json`;
const cursorTmpPath = (id: string): string => `${autosaveDir(id)}/cursor.json.tmp`;

// Atomic rewrite (temp + safeRename) — §2.9. safeRename removes an existing
// destination before renaming (Capacitor rename does not overwrite), so the
// repeated timer rewrites are mobile-safe. `nowIso` is injectable for tests.
export async function persistCursor(
  vault: Vault,
  conflictId: string,
  pos: { anchor: number; head: number; scrollTop?: number },
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  const state: CursorState = {
    v: 1,
    anchor: pos.anchor,
    head: pos.head,
    scrollTop: pos.scrollTop ?? 0,
    savedAt: nowIso,
  };
  const tmp = cursorTmpPath(conflictId);
  await vault.adapter.write(tmp, JSON.stringify(state));
  await safeRename(vault.adapter, tmp, cursorPath(conflictId));
}

// Read cursor.json. Returns null on missing / corrupt / wrong-shape — recovery
// then skips applying a selection and lets CM6 place the caret naturally
// (§2.9 / §3.5 fallback); the file's own life is independent of the log.
export async function readCursor(
  vault: Vault,
  conflictId: string,
): Promise<CursorState | null> {
  const p = cursorPath(conflictId);
  if (!(await vault.adapter.exists(p))) return null;
  try {
    const o = JSON.parse(await vault.adapter.read(p)) as Partial<CursorState>;
    if (typeof o.anchor !== "number" || typeof o.head !== "number") return null;
    return {
      v: 1,
      anchor: o.anchor,
      head: o.head,
      scrollTop: typeof o.scrollTop === "number" ? o.scrollTop : 0,
      savedAt: typeof o.savedAt === "string" ? o.savedAt : "",
    };
  } catch {
    return null; // corrupt → skip cursor apply, natural caret (§3.5)
  }
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
