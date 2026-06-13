// @vitest-environment happy-dom
//
// GATE SPIKE (Phase 5) — the advisor's #1 priority: a MIXED session round-tripped
// through REAL JSON serialization, with UNDO-BEFORE-CRASH, proving recovered==live.
//
// Closes the three gaps the earlier recovery spike left open:
//   1. mixed typing + resolution replay (type-in-ver maps structure; resolution
//      carries setStructure + resolveCaret) — their INTERACTION;
//   2. undo/redo recorded as COMMANDS in the log (the user's append-command model)
//      and replayed by re-running undo()/redo() — so undo-depth + redo-after-crash
//      reconstruct;
//   3. resolution caret survives recovery (resolveCaret marker reconstructed),
//      while typing caret is plain CM6-native (decision 2 — standard plain-text).
//
// Model: log = ordered {edit | undo | redo} entries. edit carries the ChangeSpec
// + (only for resolutions) structure:VerRange[] + caret:{before,after}. Each op is
// its own undo step (isolateHistory) — the production "1 block = 1 undo step" (1b)
// target. Replay re-runs: dispatch edits, call undo()/redo().

import { describe, expect, it } from "vitest";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { TransactionSpec } from "@codemirror/state";
import { mountDiffPaneV2 } from "../../../src/diff2/diff-pane-v2";
import {
  fromRangeSet,
  readStructure,
  resolveCaret,
  setStructure,
  toRangeSet,
} from "../../../src/diff2/diff-structure";
import { resolveGroup } from "../../../src/diff2/diff-resolve";

const BASE = "top\nA1\nmid\nB1\nbot\n";
const SIBLING = "top\nA2\nmid\nB2\nbot\n"; // ⇒ 2 diff-groups

type LogEntry =
  | { kind: "edit"; change: unknown; structure?: ReturnType<typeof fromRangeSet>; caret?: { before: number; after: number } }
  | { kind: "undo" }
  | { kind: "redo" };

// doc + structure are the load-bearing recovery guarantee (exact, always).
function docStruct(v: EditorView) {
  return { doc: v.state.doc.toString(), struct: readStructure(v.state) };
}

// serialize an edit spec to a plain JSON-able entry (the "history.jsonl line")
function serializeEdit(spec: TransactionSpec): LogEntry {
  const entry: LogEntry = { kind: "edit", change: spec.changes };
  const effs = Array.isArray(spec.effects) ? spec.effects : spec.effects ? [spec.effects] : [];
  for (const e of effs) {
    if (e.is(setStructure)) entry.structure = fromRangeSet(e.value);
    if (e.is(resolveCaret)) entry.caret = e.value;
  }
  return entry;
}

describe("GATE SPIKE — mixed session, real JSON round-trip, undo-before-crash", () => {
  it("recovered editor == live across the session AND a subsequent undo/redo walk", () => {
    const liveParent = document.createElement("div");
    const recParent = document.createElement("div");
    document.body.append(liveParent, recParent);
    const live = mountDiffPaneV2(liveParent, BASE, SIBLING);

    try {
      // ── LIVE session, recording an append-only command log ───────────────────
      const log: LogEntry[] = [];
      const edit = (spec: TransactionSpec) => {
        // JSON round-trip the entry NOW (proves it serializes) before dispatching
        log.push(JSON.parse(JSON.stringify(serializeEdit(spec))));
        live.dispatch({ ...spec, annotations: isolateHistory.of("before") });
      };
      const liveUndo = () => {
        log.push({ kind: "undo" });
        undo(live);
      };
      const liveRedo = () => {
        log.push({ kind: "redo" });
        redo(live);
      };

      // resolution-caret oracle for op2 (the resolution we'll undo/redo in the walk)
      let before2 = -1;
      let after2 = -1;

      // op1: type in NORMAL text (structure maps — no setStructure)
      edit({ changes: { from: 0, insert: "Z" } });

      // op2: resolve group 0 (keep1) — carries setStructure + resolveCaret
      {
        const r = readStructure(live.state);
        const v1 = r.find((x) => x.group === 0 && x.ver === 1)!;
        before2 = v1.from + 1;
        edit(resolveGroup(live.state.doc, r, 0, "keep1", {}, before2)!);
        after2 = live.state.selection.main.head; // forward caret = resolveCaret.after
      }

      // op3: type INTO group 1's ver1 (structure GROWS via inclusive map — no setStructure)
      {
        const v1 = readStructure(live.state).find((x) => x.group === 1 && x.ver === 1)!;
        edit({ changes: { from: v1.from + 1, insert: "q" } });
      }

      // op4: resolve group 1 (keep2)
      {
        const r = readStructure(live.state);
        const v1 = r.find((x) => x.group === 1 && x.ver === 1)!;
        edit(resolveGroup(live.state.doc, r, 1, "keep2", {}, v1.from + 1)!);
      }

      // undo-before-crash: undo×2, redo×1
      liveUndo();
      liveUndo();
      liveRedo();

      const liveFinalHead = live.state.selection.main.head; // would be persisted in cursor.json

      // ── CRASH + RECOVERY: serialize to NDJSON, parse, replay into a fresh view ─
      const jsonl = log.map((e) => JSON.stringify(e)).join("\n");
      const rec = mountDiffPaneV2(recParent, BASE, SIBLING);
      try {
        for (const line of jsonl.split("\n")) {
          const entry = JSON.parse(line) as LogEntry;
          if (entry.kind === "undo") {
            undo(rec);
          } else if (entry.kind === "redo") {
            redo(rec);
          } else {
            const effects = [];
            if (entry.structure) effects.push(setStructure.of(toRangeSet(entry.structure)));
            if (entry.caret) effects.push(resolveCaret.of(entry.caret));
            rec.dispatch({
              changes: entry.change as never,
              effects,
              annotations: isolateHistory.of("before"),
            });
          }
        }

        // ⭐ CORE GUARANTEE: doc + STRUCTURE recover EXACTLY (mixed typing+resolution
        // + command-replay of undo/redo — undo-depth reconstructed).
        expect(docStruct(rec), "doc+structure recovered == live").toEqual(docStruct(live));

        // cursor.json restore — recovery lands the caret at the persisted live head
        // (the live caret is NOT reproduced by replay; §2.9 cursor.json carries it).
        rec.dispatch({ selection: { anchor: liveFinalHead } });
        expect(rec.state.selection.main.head, "final caret from cursor.json").toBe(liveFinalHead);

        // ── undo/redo walk: doc+structure identical EVERY step; RESOLUTION caret
        //    exact (resolveCaret survived JSON round-trip); typing caret is native
        //    plain-text (decision 2 — NOT asserted to match live). ────────────────
        // state here = "after op3"; stack [op1,op2,op3], redo [op4].
        const at = (label: string) => {
          expect(docStruct(rec), `${label} doc+struct`).toEqual(docStruct(live));
        };

        undo(live); undo(rec); at("undo→after op2 (op3 typing undone)"); // typing caret: native, skip

        undo(live); undo(rec); at("undo→after op1 (op2 RESOLUTION undone)");
        expect(rec.state.selection.main.head, "resolution undo → before2 (recovered)").toBe(before2);
        expect(live.state.selection.main.head, "resolution undo → before2 (live)").toBe(before2);

        redo(live); redo(rec); at("redo→after op2 (op2 resolution redone)");
        expect(rec.state.selection.main.head, "resolution redo → after2 (recovered)").toBe(after2);
        expect(live.state.selection.main.head, "resolution redo → after2 (live)").toBe(after2);

        redo(live); redo(rec); at("redo→after op3 (op3 typing redone)"); // typing caret: native, skip
      } finally {
        rec.destroy();
        recParent.remove();
      }
    } finally {
      live.destroy();
      liveParent.remove();
    }
  });
});
