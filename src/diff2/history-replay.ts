// Stage 3b — replay the persistent REDO-log into an editor state
// (DIFF-EDITOR.md §3.3) + pre-replay assessment for the recovery dialog (§3.5).
//
// Replay reconstructs the in-progress edit by applying each block's ChangeSet
// AND setting that block's structure (format B — §2.6) via setDiffPaneState.
// Dispatching through `state.update` rebuilds CM6's undo history (each block
// becomes an undoable step), and the structure effect is versioned by
// `structureHistory`, so post-replay Ctrl+Z walks back the exact per-block
// trajectory (verified in history-replay.test.ts).
//
// SCOPE (tested core): scan/assess/replay over EditorState. The starting state
// MUST be built by the caller as toEditorModel(build(currentBase,currentSibling))
// + diffPaneExtension (+ history/structureHistory for undo) — the SAME build the
// §2.5 joinedDocSha gate validated, so the blocks' offsets line up. Rendering
// the recovery dialog, reading cursor.json, and wiring to a live view are
// Phase 6.

import { ChangeSet, type EditorState } from "@codemirror/state";
import { diffPaneStateField, setDiffPaneState } from "./decorations";
import {
  parseHistoryBlock,
  replayDispatch,
  verifyHistoryBlock,
  type HistoryBlock,
} from "./history-log";

// SINGLE source of truth for "how far the log is trustworthy" — both replay and
// assessment consume this, so the dialog's "N edits" can never disagree with
// what replay actually restores. Walks NDJSON lines: blank lines are skipped
// (NDJSON tolerance); the FIRST parse- or checksum-failure stops the scan (a
// torn final write or bit-rot truncates the trustworthy prefix).
export function scanHistory(jsonl: string): {
  blocks: HistoryBlock[];
  stoppedAtCorrupt: boolean;
} {
  const blocks: HistoryBlock[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    const block = parseHistoryBlock(line);
    if (!block || !verifyHistoryBlock(block)) {
      return { blocks, stoppedAtCorrupt: true };
    }
    blocks.push(block);
  }
  return { blocks, stoppedAtCorrupt: false };
}

// §3.5 — what the recovery dialog needs BEFORE committing to a replay.
export interface HistoryAssessment {
  edits: number; // replayable (valid-prefix) block count → "N edits saved"
  stoppedAtCorrupt: boolean; // a corrupt block truncated the log → "recovered K of N"
  empty: boolean; // no valid blocks, no corruption → stale session, no modal
  firstBlockCorrupt: boolean; // corruption at block 1 → "0 edits", [Continue] disabled
}

export function assessHistory(jsonl: string): HistoryAssessment {
  const { blocks, stoppedAtCorrupt } = scanHistory(jsonl);
  return {
    edits: blocks.length,
    stoppedAtCorrupt,
    empty: blocks.length === 0 && !stoppedAtCorrupt,
    firstBlockCorrupt: blocks.length === 0 && stoppedAtCorrupt,
  };
}

export interface ReplayResult {
  state: EditorState; // post-replay state (undo history rebuilt)
  replayed: number; // blocks applied
  stoppedAtCorrupt: boolean; // stopped before EOF on a corrupt block
}

// §3.3 — apply the trustworthy prefix of `jsonl` onto `startState`. Each block:
// apply its ChangeSet AND set its structure (setDiffPaneState), annotated
// replayDispatch so the Phase-6 transaction listener won't re-record it. opts
// are reused from the start state's field (constant per session).
export function replayHistory(startState: EditorState, jsonl: string): ReplayResult {
  const field = startState.field(diffPaneStateField, false);
  if (!field) {
    throw new Error("replayHistory: startState lacks diffPaneStateField");
  }
  const opts = field.opts;

  const { blocks, stoppedAtCorrupt } = scanHistory(jsonl);
  let state = startState;
  for (const block of blocks) {
    const cs = ChangeSet.fromJSON(block.change);
    // TODO #10 — give each replayed block a SYNTHETIC caret so post-recovery
    // undo/redo doesn't dump the cursor at 0,0. Rule (user): land at the char
    // right after the change (`toB`); if that char is a newline, drop to column
    // 0 of the next line. Derived from the change alone — no caret is stored in
    // the block (keeps the §2.6 format + checksum untouched, so a cursor value
    // can never affect crash-recovery trustworthiness). A chunk action is a
    // full-doc replace, so its `toB` is the doc end — deterministic, not 0,0.
    state = state.update({
      changes: cs,
      selection: { anchor: syntheticCaret(cs, cs.apply(state.doc)) },
      effects: setDiffPaneState.of({ structure: block.structure, opts, activeEmptyVer: null }),
      annotations: replayDispatch.of(true),
    }).state;
  }
  return { state, replayed: blocks.length, stoppedAtCorrupt };
}

// #10 — the synthetic caret offset for a replayed change: the position just
// after the LAST changed region (`toB`), nudged past a trailing newline to
// column 0 of the next line. Clamped to the new doc. Empty change → 0.
function syntheticCaret(
  change: ChangeSet,
  newDoc: import("@codemirror/state").Text,
): number {
  let pos = 0;
  let saw = false;
  change.iterChanges((_fromA, _toA, _fromB, toB) => {
    saw = true;
    pos = toB;
  });
  if (!saw) return 0;
  pos = Math.max(0, Math.min(pos, newDoc.length));
  if (pos < newDoc.length && newDoc.sliceString(pos, pos + 1) === "\n") {
    pos += 1; // next char is \n → column 0 of the next line
  }
  return pos;
}
