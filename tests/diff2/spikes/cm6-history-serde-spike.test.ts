// R12.0 Spike 2 — CM6 historyField serialization round-trip.
//
// Question (DIFF2_IMPLEMENTATION_PLAN.md §R12.0):
//   Does @codemirror/commands' `historyField` expose a JSON serde API
//   (`historyField.spec.toJSON`/`fromJSON`) that round-trips the
//   undo/redo stack cleanly across an EditorState rebuild?
//
// Why it matters:
//   R7.7.a (Phase 5) ships persistent autosave for diff-edit sessions.
//   The user's expectation: Ctrl+Z works after crash recovery → reload
//   reconstructs the in-flight undo stack from disk. If `historyField`
//   has no documented JSON serde, R7.7.a degrades to buffer-only
//   autosave (recovery dialog still works, but undo starts fresh).
//
// Expected outcome (PASS):
//   toJSON returns plain JSON, fromJSON rehydrates a state whose first
//   `undo` keystroke reverts the most recent edit. Multi-edit chains
//   (3+ steps) survive intact.
//
// Fallback (FAIL):
//   R7.7.a documents the "buffer-only autosave" degradation path:
//   recovery dialog rehydrates buffer.txt + cursor.json, but the
//   CM6 historyField starts empty (no undo to before-recovery
//   state). PR-5 acceptance criteria updates accordingly.

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { history, historyField, undo } from "@codemirror/commands";

describe("R12.0 Spike 2 — CM6 historyField JSON serde round-trip", () => {
  it("EditorState.toJSON/fromJSON accept historyField in the fields map", () => {
    // Public API path: EditorState.toJSON(fields?) and
    // EditorState.fromJSON(json, config?, fields?). The fields map
    // keys field names to their StateField objects; CM6 dispatches
    // serialization through each field's internal spec.toJSON/fromJSON.
    const state = EditorState.create({
      doc: "x",
      extensions: [history()],
    });
    const json = state.toJSON({ historyField });
    expect(json).toHaveProperty("historyField");
    expect(typeof json.historyField).toBe("object");
  });

  it("round-trips a single edit: toJSON → fromJSON → undo restores", () => {
    let state = EditorState.create({
      doc: "initial",
      extensions: [history()],
    });

    // Make one edit via a user-style transaction (records into history).
    state = state.update({
      changes: { from: state.doc.length, insert: " edit-1" },
      // userEvent="input" causes history extension to record this as
      // an undoable step (not a programmatic change that history skips).
      userEvent: "input",
    }).state;
    expect(state.doc.toString()).toBe("initial edit-1");

    // Serialize via public toJSON API.
    const json = state.toJSON({ historyField });
    // Must be JSON-cloneable.
    const cloned = JSON.parse(JSON.stringify(json));

    // Rehydrate via public fromJSON API.
    const rehydratedState = EditorState.fromJSON(
      cloned,
      { extensions: [history()] },
      { historyField },
    );
    expect(rehydratedState.doc.toString()).toBe("initial edit-1");

    // Apply the undo command — should revert to the pre-edit doc.
    let resolved: EditorState | null = null;
    undo({
      state: rehydratedState,
      dispatch: (tr) => { resolved = tr.state; },
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.doc.toString()).toBe("initial");
  });

  it("round-trips a multi-edit chain (3 steps, undo each in reverse)", () => {
    // `newGroupDelay: 0` forces each transaction into its own history
    // group, mirroring R7.7.a where every per-chunk action lands as a
    // distinct undoable step (user expects Ctrl+Z to revert one chunk
    // at a time, not the whole burst).
    let state = EditorState.create({
      doc: "v0",
      extensions: [history({ newGroupDelay: 0 })],
    });
    state = state.update({
      changes: { from: state.doc.length, insert: "→step1" },
      userEvent: "input",
    }).state;
    state = state.update({
      changes: { from: state.doc.length, insert: "→step2" },
      userEvent: "input",
    }).state;
    state = state.update({
      changes: { from: state.doc.length, insert: "→step3" },
      userEvent: "input",
    }).state;
    expect(state.doc.toString()).toBe("v0→step1→step2→step3");

    // Serialize + rehydrate via public API.
    const json = state.toJSON({ historyField });
    const cloned = JSON.parse(JSON.stringify(json));
    const rehydrated = EditorState.fromJSON(
      cloned,
      { extensions: [history({ newGroupDelay: 0 })] },
      { historyField },
    );

    // Three undos in sequence — verify each step reverts.
    let cur = rehydrated;
    const undoOnce = (s: EditorState): EditorState => {
      let next: EditorState | null = null;
      undo({ state: s, dispatch: (tr) => { next = tr.state; } });
      if (!next) throw new Error("undo did not dispatch");
      return next!;
    };

    cur = undoOnce(cur);
    expect(cur.doc.toString()).toBe("v0→step1→step2");
    cur = undoOnce(cur);
    expect(cur.doc.toString()).toBe("v0→step1");
    cur = undoOnce(cur);
    expect(cur.doc.toString()).toBe("v0");
  });

  it("JSON shape is plain (no circular refs, no functions)", () => {
    // Crash-survival assertion: persisted JSON must survive
    // JSON.stringify→JSON.parse without losing data. If it has
    // functions, prototype methods, or circular refs, atomicWriteJson
    // in R7.7.a can't persist it.
    let state = EditorState.create({
      doc: "x",
      extensions: [history()],
    });
    state = state.update({
      changes: { from: 1, insert: "y" },
      userEvent: "input",
    }).state;

    const json = state.toJSON({ historyField });
    const stringified = JSON.stringify(json);
    expect(stringified.length).toBeGreaterThan(0);
    const reparsed = JSON.parse(stringified);
    // The two should be deep-equal.
    expect(reparsed).toEqual(json);
  });
});
