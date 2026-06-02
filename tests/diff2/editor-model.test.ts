// §1 editor-model (Rep A) — clean CM6 doc + structure mapped through
// every transaction. Pins the seam invariant, structure tiling, and the
// mapStructure assoc rule (interior edits, empty-ver growth, edge-append).
//
// Canonical spec: docs/tasks/DIFF-EDITOR.md §1.1–§1.8.

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { LINE_TERMINATOR, VER_SEPARATOR } from "../../src/diff2/joined-doc";
import {
  type ActiveBlock,
  type EditorModel,
  type Segment,
  baseSiblingToModel,
  fromEditorModel,
  growIndexFor,
  growSegmentIndex,
  mapStructure,
  modelToBaseSibling,
} from "../../src/diff2/editor-model";

// Apply an edit through CM6 and map the structure with it. `active` (an empty
// ver-block) wins via growIndexFor; otherwise the grown segment is the one
// containing the edit position (mirrors the field's growIndexFor(caret)).
function edit(
  model: EditorModel,
  spec: { from: number; to?: number; insert?: string },
  active?: ActiveBlock,
): EditorModel {
  const state = EditorState.create({ doc: model.doc });
  const changes = state.changes(spec);
  const doc = changes.apply(state.doc).toString();
  const growIdx = active
    ? growIndexFor(model.structure, active, spec.from)
    : growSegmentIndex(model.structure, spec.from);
  return { doc, structure: mapStructure(model.structure, changes, growIdx) };
}

function seg(model: EditorModel, role: string, group: number): Segment {
  const f = model.structure.find((s) => s.role === role && s.group === group);
  if (!f) throw new Error(`no seg ${role}/${group}`);
  return f;
}
function assertTiles(model: EditorModel): void {
  const flat = model.structure;
  expect(flat.length).toBeGreaterThan(0);
  expect(flat[0].from).toBe(0);
  for (let i = 1; i < flat.length; i++) {
    expect(flat[i].from).toBe(flat[i - 1].to); // contiguous, no gap/overlap
  }
  expect(flat[flat.length - 1].to).toBe(model.doc.length);
}

const PAIRS: Array<[string, string, string]> = [
  ["one-change", "a\nb\nc\n", "a\nX\nc\n"],
  ["sibling-add", "a\nc\n", "a\nb\nc\n"], // empty ver1 adjacent to its ver2
  ["base-remove", "a\nb\nc\n", "a\nc\n"], // empty ver2 adjacent to next normal
  ["multi-region", "a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n"],
  ["no-eol", "a\nb", "a\nX"],
  ["empty-base", "", "hello\n"],
  ["identical", "a\nb\n", "a\nb\n"],
];

describe("editor-model — seam invariant", () => {
  for (const [name, base, sibling] of PAIRS) {
    it(`split∘fromEditorModel∘toEditorModel∘build === id: ${name}`, () => {
      const model = baseSiblingToModel(base, sibling);
      expect(modelToBaseSibling(model)).toEqual({ base, sibling });
    });
  }

  it("cmDoc carries NO sentinels", () => {
    const model = baseSiblingToModel("a\nb\nc\n", "a\nX\nc\n");
    expect(model.doc.includes(LINE_TERMINATOR)).toBe(false);
    expect(model.doc.includes(VER_SEPARATOR)).toBe(false);
  });

  it("structure tiles the doc contiguously (incl. empty ver-blocks)", () => {
    assertTiles(baseSiblingToModel("a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n"));
    assertTiles(baseSiblingToModel("a\nc\n", "a\nb\nc\n")); // empty ver1
    assertTiles(baseSiblingToModel("a\nb\nc\n", "a\nc\n")); // empty ver2
  });

  it("document order: ver1 precedes its (possibly empty) ver2", () => {
    const m = baseSiblingToModel("a\nc\n", "a\nb\nc\n");
    const i1 = m.structure.findIndex((s) => s.role === "ver1" && s.group === 0);
    const i2 = m.structure.findIndex((s) => s.role === "ver2" && s.group === 0);
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);
    expect(m.structure[i1].from).toBe(m.structure[i1].to); // empty ver1
  });

  it("document order: empty ver2 precedes the following normal line", () => {
    const m = baseSiblingToModel("a\nb\nc\n", "a\nc\n");
    const i2 = m.structure.findIndex((s) => s.role === "ver2" && s.group === 0);
    const v2 = m.structure[i2];
    expect(v2.from).toBe(v2.to); // empty ver2
    const next = m.structure[i2 + 1];
    expect(next.role).toBe("normal"); // "c\n" comes right after the empty ver2
  });
});

describe("editor-model — split stays sound after free edits", () => {
  it("interior edit in ver1 → base reflects, sibling intact", () => {
    let m = baseSiblingToModel("a\nold\nc\n", "a\nnew\nc\n");
    const v = seg(m, "ver1", 0);
    m = edit(m, { from: v.to - 1, insert: "X" }, { role: "ver1", group: 0 });
    expect(modelToBaseSibling(m)).toEqual({
      base: "a\noldX\nc\n",
      sibling: "a\nnew\nc\n",
    });
    assertTiles(m);
  });

  it("interior edit in ver2 → sibling reflects, base intact", () => {
    let m = baseSiblingToModel("a\nold\nc\n", "a\nnew\nc\n");
    const v = seg(m, "ver2", 0);
    m = edit(m, { from: v.to - 1, insert: "Y" }, { role: "ver2", group: 0 });
    expect(modelToBaseSibling(m)).toEqual({
      base: "a\nold\nc\n",
      sibling: "a\nnewY\nc\n",
    });
    assertTiles(m);
  });

  it("edit in a normal line → both sides reflect", () => {
    let m = baseSiblingToModel("intro\nold\nc\n", "intro\nnew\nc\n");
    m = edit(m, { from: 5, insert: "!" }); // after "intro", normal segment
    expect(modelToBaseSibling(m)).toEqual({
      base: "intro!\nold\nc\n",
      sibling: "intro!\nnew\nc\n",
    });
    assertTiles(m);
  });

  it("empty ver-block grows when active (§1.8.a attribution)", () => {
    let m = baseSiblingToModel("a\nc\n", "a\nb\nc\n");
    const v1 = seg(m, "ver1", 0);
    expect(v1.from).toBe(v1.to);
    m = edit(m, { from: v1.from, insert: "Q" }, { role: "ver1", group: 0 });
    // §1.6.a.2 commit-boundary normalization: ver1 "Q" is non-empty, lacks a
    // trailing \n, and its group is not the document's last element → "Q\n",
    // so it does not merge with the following normal line.
    expect(modelToBaseSibling(m)).toEqual({
      base: "a\nQ\nc\n",
      sibling: "a\nb\nc\n",
    });
    assertTiles(m);
  });

  it("append at the END of an active non-empty ver goes to that ver", () => {
    let m = baseSiblingToModel("a\nold\nc\n", "a\nnew\nc\n");
    const v1 = seg(m, "ver1", 0);
    m = edit(m, { from: v1.to, insert: "Z" }, { role: "ver1", group: 0 });
    const out = modelToBaseSibling(m);
    // ver1 becomes "old\nZ"; §1.6.a.2 commit normalization gives the last
    // line a \n (group is not the document's last element), so "Z" stays a
    // separate line rather than merging with "c".
    expect(out.base).toBe("a\nold\nZ\nc\n");
    expect(out.sibling).toBe("a\nnew\nc\n");
    assertTiles(m);
  });

  it("two sequential edits in different regions stay sound", () => {
    let m = baseSiblingToModel("a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n");
    let v = seg(m, "ver1", 0);
    m = edit(m, { from: v.to - 1, insert: "1" }, { role: "ver1", group: 0 });
    v = seg(m, "ver2", 1);
    m = edit(m, { from: v.to - 1, insert: "2" }, { role: "ver2", group: 1 });
    expect(modelToBaseSibling(m)).toEqual({
      base: "a\nb1\nc\nd\ne\n",
      sibling: "a\nB\nc\nD2\ne\n",
    });
    assertTiles(m);
  });

  it("deleting all of a ver's content collapses it to empty; tiling holds", () => {
    let m = baseSiblingToModel("a\nold\nc\n", "a\nnew\nc\n");
    const v = seg(m, "ver1", 0); // "old\n"
    m = edit(m, { from: v.from, to: v.to }, { role: "ver1", group: 0 });
    const after = seg(m, "ver1", 0);
    expect(after.from).toBe(after.to); // collapsed to empty
    assertTiles(m);
    expect(modelToBaseSibling(m)).toEqual({
      base: "a\nc\n",
      sibling: "a\nnew\nc\n",
    });
  });
});

describe("editor-model — corruption guards", () => {
  it("fromEditorModel throws on a dangling ver1 (no paired ver2)", () => {
    const structure: Segment[] = [{ role: "ver1", group: 0, from: 0, to: 1 }];
    expect(() => fromEditorModel({ doc: "x", structure })).toThrow(
      /not.*followed by its ver2/,
    );
  });
});
