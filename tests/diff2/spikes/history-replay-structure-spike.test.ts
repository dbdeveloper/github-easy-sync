// @vitest-environment happy-dom
//
// Stage 3 GATE spike (DIFF-EDITOR.md §2.6 block format).
//
// Question: is `ChangeSet.toJSON` (doc changes ONLY — no StateEffects) enough
// to reconstruct the Rep-A Segment[] structure on history replay? If not, the
// §2.6 block must persist the structure too, and §2.6 (written pre-Rep-A)
// needs reconciling.
//
// We drive a REAL DiffPane (full filter pipeline), capture each transaction's
// changes + any setDiffPaneState structure, then replay onto a fresh
// diffPaneStateField state under three formats and compare getResolved():
//   A) change-only                          → expected: chunk action diverges
//   C) change + structure on effect-blocks  → expected: matches live
//   (free-edit-only path also checked: does mapStructure reproduce on replay?)

import { describe, it, expect } from "vitest";
import { ChangeSet, EditorSelection, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { DiffPane } from "../../../src/diff2/diff-pane";
import {
  diffPaneExtension,
  diffPaneStateField,
  setActiveEmptyVer,
  setDiffPaneState,
  type BuildOpts,
} from "../../../src/diff2/decorations";
import {
  baseSiblingToModel,
  fromEditorModel,
  type Segment,
} from "../../../src/diff2/editor-model";
import { split } from "../../../src/diff2/joined-doc";

const OPTS: BuildOpts = {
  oursLabel: "local",
  theirsLabel: "remote",
  isMarkdown: true,
  callbacks: {} as never,
};

interface Block {
  change: unknown; // ChangeSet.toJSON()
  effectStructure: Segment[] | null; // from a setDiffPaneState effect, else null (format C)
  structureAfter: Segment[]; // post-tx structure regardless of how derived (format B)
}
type Mode = "A" | "C" | "B"; // A=change-only, C=structure-on-effect-blocks, B=structure-every-block

// Run a live DiffPane through `ops`, capturing one Block per transaction.
function record(
  base: string,
  sibling: string,
  ops: (pane: DiffPane, view: EditorView) => void,
): { blocks: Block[]; liveResolved: { base: string; sibling: string } } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const pane = new DiffPane(container, base, sibling, OPTS);
  const view = pane.getView();

  const blocks: Block[] = [];
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) {
          if (!tr.docChanged && !tr.effects.some((e) => e.is(setDiffPaneState))) continue;
          let effectStructure: Segment[] | null = null;
          for (const e of tr.effects) {
            if (e.is(setDiffPaneState)) effectStructure = e.value.structure;
          }
          blocks.push({
            change: tr.changes.toJSON(),
            effectStructure,
            structureAfter: u.state.field(diffPaneStateField)!.structure,
          });
        }
      }),
    ),
  });

  ops(pane, view);
  const liveResolved = pane.getResolved();
  pane.destroy();
  container.remove();
  return { blocks, liveResolved };
}

// Replay blocks onto a fresh structure-aware state; return getResolved-equiv.
function replay(
  base: string,
  sibling: string,
  blocks: Block[],
  mode: Mode,
): { base: string; sibling: string } {
  const initial = baseSiblingToModel(base, sibling);
  let state = EditorState.create({
    doc: initial.doc,
    extensions: [diffPaneExtension({ structure: initial.structure, opts: OPTS, activeEmptyVer: null })],
  });
  for (const blk of blocks) {
    const cs = ChangeSet.fromJSON(blk.change);
    const struct =
      mode === "B" ? blk.structureAfter : mode === "C" ? blk.effectStructure : null;
    const effects = struct
      ? [setDiffPaneState.of({ structure: struct, opts: OPTS, activeEmptyVer: null })]
      : [];
    state = state.update({ changes: cs, effects }).state;
  }
  const structure = state.field(diffPaneStateField)!.structure;
  const { base: b, sibling: s } = split(fromEditorModel({ doc: state.doc.toString(), structure }));
  return { base: b === "" ? "\n" : b, sibling: s === "" ? "\n" : s };
}

describe("Stage 3 gate — ChangeSet-only replay vs Rep-A structure", () => {
  // TWO conflict groups so resolving ONE leaves real structure that split()
  // must still get right — a single-group "resolve to fully merged" doc has no
  // residual structure to corrupt and would mask the bug.
  const BASE = "top\nb1\nmid\nd1\nbot\n";
  const SIB = "top\nB1\nmid\nD1\nbot\n"; // group0: b1/B1, group1: d1/D1

  it("chunk action (1 of 2 groups): change-only (A) DIVERGES — structure not in doc", () => {
    const { blocks, liveResolved } = record(BASE, SIB, (pane) => {
      pane.applyToChunk(0, "ours"); // resolve group0; group1 still conflicting
    });
    expect(replay(BASE, SIB, blocks, "A")).not.toEqual(liveResolved); // GATE
  });

  it("chunk action (1 of 2 groups): change + effect-structure (C) MATCHES live", () => {
    const { blocks, liveResolved } = record(BASE, SIB, (pane) => {
      pane.applyToChunk(0, "ours");
    });
    expect(replay(BASE, SIB, blocks, "C")).toEqual(liveResolved);
  });

  it("mixed free-edit + chunk action: format C reproduces live exactly", () => {
    const { blocks, liveResolved } = record(BASE, SIB, (pane, view) => {
      view.dispatch({ changes: { from: 1, insert: "Z" } }); // mid normal line "top"
      pane.applyToChunk(1, "theirs"); // resolve group1 to ver2; group0 remains
    });
    expect(replay(BASE, SIB, blocks, "C")).toEqual(liveResolved);
  });

  it("free-edit-only (both groups remain): change-only (A) reproduces via mapStructure", () => {
    const { blocks, liveResolved } = record(BASE, SIB, (pane, view) => {
      view.dispatch({ changes: { from: 1, insert: "Z" } }); // inside "top"
      view.dispatch({ changes: { from: 0, insert: "Q" } }); // doc start
    });
    expect(replay(BASE, SIB, blocks, "A")).toEqual(liveResolved);
  });
});

describe("Stage 3 gate — typing into an ACTIVE empty ver (growIndex risk)", () => {
  // base side of the group is EMPTY (sibling adds "X"): a zero-width ver1.
  const BASE = "a\nc\n";
  const SIB = "a\nX\nc\n";

  function typeIntoEmptyVer() {
    return record(BASE, SIB, (_pane, view) => {
      const seg = view.state
        .field(diffPaneStateField)!
        .structure.find((s) => s.role === "ver1" && s.from === s.to);
      if (!seg) throw new Error("expected an empty ver1 segment");
      // Replicate DiffPane.activateEmptyVer, then type — grows the empty ver.
      view.dispatch({
        selection: EditorSelection.single(seg.from),
        effects: setActiveEmptyVer.of({ group: seg.group, role: "ver1" }),
      });
      view.dispatch({ changes: { from: view.state.selection.main.head, insert: "NEW" } });
    });
  }

  it("change-only (A) DIVERGES → free-edit-while-empty-ver-active needs structure (⇒ format B)", () => {
    const { blocks, liveResolved } = typeIntoEmptyVer();
    // Hypothesis: replay has no activeEmptyVer, so growIndexFor falls back to
    // growSegmentIndex at the zero-width point and grows the wrong segment.
    expect(replay(BASE, SIB, blocks, "A")).not.toEqual(liveResolved);
  });

  it("structure-every-block (B): ALWAYS reproduces live (bulletproof)", () => {
    const { blocks, liveResolved } = typeIntoEmptyVer();
    expect(replay(BASE, SIB, blocks, "B")).toEqual(liveResolved);
  });
});
