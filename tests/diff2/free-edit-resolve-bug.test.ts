// @vitest-environment happy-dom
//
// Minimal repro for a bug surfaced by the Stage-3 large-doc stress test:
// resolving a conflict by a FREE-EDIT that selects across it (from mid of the
// normal line before to mid of the normal line after) and replaces with text
// should — per DIFF-EDITOR.md "розв'язок = заміна diff-рядка нормальними
// рядками" — leave that text as a NORMAL line in BOTH output files. The
// deletion happens, but the inserted text is dropped.

import { describe, it, expect } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";
import { diffPaneStateField, type BuildOpts } from "../../src/diff2/decorations";

const OPTS: BuildOpts = {
  oursLabel: "local",
  theirsLabel: "remote",
  isMarkdown: true,
  callbacks: {} as never,
};

// SKIPPED regression — documents a CONFIRMED Stage-1 bug (§1.7.a (0) in
// DIFF-EDITOR.md). A Variant-3 replace (normal→through-diff→normal) is a banal
// text replace and must yield normal text in BOTH files; today mapStructure
// can't tile a change spanning whole segments, so the inserted text lands in a
// gap (vanishes) or a malformed overlap. Un-skip when the §1.7.a (0) fix lands.
describe("free-edit resolution across a conflict block (§1.7 Variant 3)", () => {
  it.skip("replacing [mid-normal-before .. mid-normal-after] with text keeps the text in BOTH sides", () => {
    // doc (Rep A clean): n1, n2, A (ver1), B (ver2), n3, n4 — one conflict.
    const base = "n1\nn2\nA\nn3\nn4\n";
    const sibling = "n1\nn2\nB\nn3\nn4\n";

    const container = document.createElement("div");
    document.body.appendChild(container);
    const pane = new DiffPane(container, base, sibling, OPTS);
    const view = pane.getView();

    const st = view.state.field(diffPaneStateField)!.structure;
    const v1 = st.find((s) => s.role === "ver1" && s.group === 0)!;
    const v2 = st.find((s) => s.role === "ver2" && s.group === 0)!;
    const doc = view.state.doc;
    const beforeLine = doc.lineAt(v1.from - 1); // "n2"
    const afterLine = doc.lineAt(v2.to); // "n3"
    // Select from mid of n2 to mid of n3, replace with TEST.
    const from = beforeLine.from + 1; // after "n"
    const to = afterLine.from + 1; // after "n"
    // Faithful "select then type": set the selection FIRST (so the replace
    // transaction's startState carries it), THEN replace — mirrors real input.
    view.dispatch({ selection: { anchor: from, head: to } });
    view.dispatch({ changes: { from: view.state.selection.main.from, to: view.state.selection.main.to, insert: "TEST" } });

    const { base: rb, sibling: rs } = pane.getResolved();
    pane.destroy();
    container.remove();

    // Invariants (not an exact string that depends on the bug): the conflict
    // is resolved → identical in BOTH files; the typed text survives; the
    // pre-conflict A/B content is gone.
    expect(rb).toBe(rs); // resolved → identical in both files
    expect(rb).toContain("TEST");
    expect(rs).toContain("TEST");
    expect(rb).not.toContain("A");
    expect(rb).not.toContain("B");
    expect(rb).toBe("n1\nnTEST3\nn4\n"); // banal text replace, diff consumed
  });
});
