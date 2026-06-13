// @vitest-environment happy-dom
//
// SPIKE — the undo/redo CURSOR + STRUCTURE oracle across 3 diff-groups surrounded
// by normal text, for KEYBOARD-hotkey resolution (the user's exact scenario:
// "enter a ver1-block, press Ctrl+Enter").
//
// CORRECTED cursor model (§2.2.9 — earlier "edge-stable both ways" was WRONG):
// the caret is DIRECTION-dependent, each direction to its OWN proper place —
//   • FORWARD  (resolve / redo) → END of the resolved insert (copy-paste);
//   • BACKWARD (undo)           → exactly WHERE THE HOTKEY WAS PRESSED.
// (Pointer/tap differs only in the backward target — group start — covered in the
// diff-pane-v2 unit tests; this spike pins the keyboard stack.)
//
// What this proves about the LIVE model (resolution is the structure-mutating op
// we have today; cut/paste land in Phase 5):
//   1. each resolution is ITS OWN undo step (undo×3 visits R2,R1,R0 distinctly);
//   2. doc + STRUCTURE restored on every undo/redo (structureHistory over a STACK);
//   3. caret FORWARD = END, caret BACKWARD = press-position — held across an
//      arbitrary undo/redo/ping-pong walk, never drifting to 0.

import { describe, expect, it } from "vitest";
import { redo, undo } from "@codemirror/commands";
import { mountDiffPaneV2 } from "../../../src/diff2/diff-pane-v2";
import { readStructure } from "../../../src/diff2/diff-structure";
import { resolveCurrentGroup } from "../../../src/diff2/diff-resolve";

// 3 changed regions separated by normal lines ⇒ 3 diff-groups.
const BASE = "top\nA1\nmid1\nB1\nmid2\nC1\nbot\n";
const SIBLING = "top\nA2\nmid1\nB2\nmid2\nC2\nbot\n";

interface Snap {
  doc: string;
  struct: ReturnType<typeof readStructure>;
}

describe("SPIKE v2 undo/redo cursor — 3 groups + normal text (keyboard hotkey)", () => {
  it("undo×3 / redo×3 / ping-pong: structure restored; FORWARD=end, BACKWARD=press-position", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = mountDiffPaneV2(parent, BASE, SIBLING);
    const snap = (): Snap => ({
      doc: view.state.doc.toString(),
      struct: readStructure(view.state),
    });

    try {
      // ── three groups present ───────────────────────────────────────────────
      expect([...new Set(readStructure(view.state).map((r) => r.group))].sort()).toEqual([0, 1, 2]);

      // ── resolve each via keyboard, capturing press- and end-positions ───────
      const states: Snap[] = [snap()]; // R0
      const pressAt: number[] = []; // pressAt[k] = caret where the k-th hotkey fired (UNDO target)
      const endAt: number[] = []; // endAt[k]   = caret after the k-th resolve   (REDO target)

      for (const g of [0, 1, 2]) {
        // place the caret INSIDE group g (where the user would be before Ctrl+Enter)
        const v1 = readStructure(view.state).find((r) => r.group === g && r.ver === 1)!;
        const press = v1.from + 1; // one char into the ver1 content
        view.dispatch({ selection: { anchor: press } });
        pressAt[g] = press;
        expect(resolveCurrentGroup(view, g === 1 ? "keep2" : g === 2 ? "both" : "keep1")).toBe(true);
        endAt[g] = view.state.selection.main.head;
        states.push(snap()); // R(g+1)
      }

      // all resolved at R3; distinct intermediate structures (no coalesced jump)
      expect(states[3].struct).toEqual([]);
      expect(states[0].struct).toHaveLength(6); // 3 groups × 2 ver-ranges
      expect(states[1].struct).toHaveLength(4);
      expect(states[2].struct).toHaveLength(2);

      // ── driver ──────────────────────────────────────────────────────────────
      let idx = 3;
      const expectState = (label: string) => {
        expect(states[idx].doc, `${label} doc`).toBe(view.state.doc.toString());
        expect(states[idx].struct, `${label} struct`).toEqual(readStructure(view.state));
      };
      const stepUndo = (label: string) => {
        const edge = idx - 1;
        undo(view);
        idx--;
        expectState(label);
        // BACKWARD: caret returns to where that group's hotkey was pressed
        expect(view.state.selection.main.head, `${label} caret=press`).toBe(pressAt[edge]);
      };
      const stepRedo = (label: string) => {
        const edge = idx;
        redo(view);
        idx++;
        expectState(label);
        // FORWARD: caret at the END of that group's resolved insert
        expect(view.state.selection.main.head, `${label} caret=end`).toBe(endAt[edge]);
      };

      // full unwind then rewind
      stepUndo("undo→R2");
      stepUndo("undo→R1");
      stepUndo("undo→R0");
      expect(idx).toBe(0);
      stepRedo("redo→R1");
      stepRedo("redo→R2");
      stepRedo("redo→R3");
      expect(idx).toBe(3);

      // ── ping-pong: each edge crossed both ways lands on ITS OWN per-direction
      //    position (end forward, press backward), never 0 ──────────────────────
      stepUndo("pp undo→R2"); // edge2 backward → pressAt[2]
      stepRedo("pp redo→R3"); // edge2 forward  → endAt[2]
      stepUndo("pp undo→R2");
      stepUndo("pp undo→R1"); // edge1 backward → pressAt[1]
      stepRedo("pp redo→R2"); // edge1 forward  → endAt[1]
      stepUndo("pp undo→R1");
      stepUndo("pp undo→R0"); // edge0 backward → pressAt[0]
      stepRedo("pp redo→R1"); // edge0 forward  → endAt[0]
      stepUndo("pp undo→R0");
      expect(idx).toBe(0);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  // Deterministic VARYING-DEPTH walk — not just alternating, but runs of undos and
  // redos that reverse direction at every depth (undo-redo-undo-undo-redo-redo…).
  // This is the walk that catches depth-dependent drift the monotone test misses.
  // mulberry32 seeded PRNG (Math.random is fine in a test, but seeding keeps it
  // reproducible).
  it("varying-depth fuzz (60 steps): doc+structure ALWAYS exact; quantify cursor exactness", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = mountDiffPaneV2(parent, BASE, SIBLING);

    const mulberry32 = (seed: number) => () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    try {
      // ── resolve 3 groups via keyboard, capture states + press/end positions ──
      const states = [{ doc: view.state.doc.toString(), struct: readStructure(view.state) }];
      const pressAt: number[] = [];
      const endAt: number[] = [];
      for (const g of [0, 1, 2]) {
        const v1 = readStructure(view.state).find((r) => r.group === g && r.ver === 1)!;
        const press = v1.from + 1;
        view.dispatch({ selection: { anchor: press } });
        pressAt[g] = press;
        resolveCurrentGroup(view, g === 1 ? "keep2" : g === 2 ? "both" : "keep1");
        endAt[g] = view.state.selection.main.head;
        states.push({ doc: view.state.doc.toString(), struct: readStructure(view.state) });
      }

      const rand = mulberry32(0x5eed);
      let idx = 3;
      let cursorExact = 0;
      let cursorSane = 0;
      let total = 0;
      const drifts: string[] = [];

      for (let step = 0; step < 60; step++) {
        const goUndo = idx === 3 ? true : idx === 0 ? false : rand() < 0.5;
        const edge = goUndo ? idx - 1 : idx;
        const expectCursor = goUndo ? pressAt[edge] : endAt[edge];
        if (goUndo) {
          undo(view);
          idx--;
        } else {
          redo(view);
          idx++;
        }

        // HARD: doc + structure must always be exactly the snapshot for this node.
        expect(view.state.doc.toString(), `step ${step} doc @R${idx}`).toBe(states[idx].doc);
        expect(readStructure(view.state), `step ${step} struct @R${idx}`).toEqual(states[idx].struct);

        // SOFT (measured): cursor exactness + sanity.
        total++;
        const head = view.state.selection.main.head;
        if (head === expectCursor) cursorExact++;
        else drifts.push(`step ${step} ${goUndo ? "undo" : "redo"}@edge${edge}: want ${expectCursor}, got ${head}`);
        if (head >= 0 && head <= view.state.doc.length) cursorSane++;
      }

      // Structure is the load-bearing guarantee — it must be perfect across depth.
      // Cursor exactness is the OPEN finding (CM6 native history can't honour the
      // §2.2.9 before/after positions across direction reversals) — we REPORT it.
      // eslint-disable-next-line no-console
      console.log(`[fuzz] cursor exact ${cursorExact}/${total}, sane ${cursorSane}/${total}`);
      if (drifts.length) console.log("[fuzz] first drifts:\n" + drifts.slice(0, 6).join("\n"));

      expect(cursorSane).toBe(total); // never 0,0-garbage / out-of-range
      // This is the falsification target: it will FAIL until the explicit-cursor
      // (log-as-undo) mechanism lands. The NUMBER is the deliverable.
      expect(cursorExact).toBe(total);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
