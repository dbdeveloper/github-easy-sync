// @vitest-environment happy-dom
//
// VIEW-LEVEL PROBE — validate the explicit-cursor-history mechanism on a MOUNTED
// EditorView with the REAL undo()/redo() commands (not state-level simulation).
//
// Mechanism (no re-entrancy): a `caretRestore` StateEffect carries {before, after};
// `invertedEffects` propagates it onto the undo AND redo transactions (the
// structureHistory pattern); a `transactionFilter` APPENDS the right selection to
// the SAME undo/redo transaction (undo→before, redo→after) — one transaction, no
// nested dispatch. This is the pattern we'll ship for §2.2.9 cursor handling.

import { describe, expect, it } from "vitest";
import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, invertedEffects, redo, undo } from "@codemirror/commands";

// carries the desired caret for each direction of a resolution
const caretRestore = StateEffect.define<{ before: number; after: number }>();

// propagate the marker onto the inverse (undo) — and its inverse (redo) — so every
// hop of the undo/redo round-trip carries {before, after}.
const cursorHistory = invertedEffects.of((tr) => {
  for (const e of tr.effects) if (e.is(caretRestore)) return [caretRestore.of(e.value)];
  return [];
});

// on an undo/redo transaction carrying the marker, dispatch a selection-only
// follow-up (addToHistory:false) from updateListener. THIS is the re-entrancy the
// user asked to validate: dispatching a new transaction from inside the listener
// that fires after the undo/redo transaction is applied.
const cursorListener = EditorView.updateListener.of((u) => {
  for (const tr of u.transactions) {
    const e = tr.effects.find((x) => x.is(caretRestore)) as
      | StateEffect<{ before: number; after: number }>
      | undefined;
    if (!e) continue;
    let pos: number | null = null;
    if (tr.isUserEvent("undo")) pos = e.value.before;
    else if (tr.isUserEvent("redo")) pos = e.value.after;
    if (pos !== null) {
      u.view.dispatch({
        selection: { anchor: pos },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }
});

describe("VIEW PROBE — explicit cursor-history via updateListener (re-entrancy OK)", () => {
  it("undo→before, redo→after, undo-after-redo→before — on a real view", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    // unresolved doc; group span [2,8) collapses to "L\n" on resolve. Hotkey at 3.
    const view = new EditorView({
      state: EditorState.create({
        doc: "a\nL\n\nR\n\nc\n",
        extensions: [history(), cursorHistory, cursorListener],
      }),
      parent,
    });
    try {
      const head = () => view.state.selection.main.head;

      // forward resolve: replace the group span with "L\n", caret at END(4),
      // marker {before: 3 (hotkey), after: 4 (end)}.
      view.dispatch({
        changes: { from: 2, to: 8, insert: "L\n" },
        selection: { anchor: 4 },
        effects: caretRestore.of({ before: 3, after: 4 }),
        annotations: Transaction.userEvent.of("input.resolve"),
      });
      expect(view.state.doc.toString()).toBe("a\nL\nc\n");
      expect(head()).toBe(4); // forward → end

      undo(view);
      expect(view.state.doc.toString()).toBe("a\nL\n\nR\n\nc\n");
      expect(head(), "undo → before (hotkey 3)").toBe(3);

      redo(view);
      expect(view.state.doc.toString()).toBe("a\nL\nc\n");
      expect(head(), "redo → after (end 4)").toBe(4);

      undo(view);
      expect(head(), "undo-after-redo → before (hotkey 3)").toBe(3); // ⭐ the drift case

      // one more round-trip for good measure
      redo(view);
      expect(head()).toBe(4);
      undo(view);
      expect(head(), "second undo-after-redo still → before").toBe(3);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
