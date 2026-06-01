// Retrofit Spike — Rep A editor model (clean CM6 doc + mapped structure).
//
// Question (Etap 1b architecture):
//   The joined-doc spike validated Rep B (sentinels \0/\1 live as real
//   chars in the doc). We are NOT shipping Rep B — its \n/\0 mix fights
//   CM6's line model. Rep A keeps the shipped clean-doc + widget-markers
//   substrate and adds the one thing it lacked: a STRUCTURE that maps
//   through EVERY transaction (the shipped diff-chunks side-field only
//   updated on button effects → desynced on free edits).
//
//   Rep A soundness rests on this DIFFERENT, untested mechanism. This
//   spike is the real derisking: build (cmDoc, structure) from
//   build(base,sibling); apply free edits inside ver1 / ver2 / normal /
//   an empty ver-block; after each, assert
//       split(fromEditorModel(cmDoc, structure)) === (base, sibling).
//
//   Structure is a CM6 RangeSet<Seg> mapped via RangeSet.map(changes) —
//   the production mechanism the advisor recommended.
//
// Two-step seam (layers 1a, does not discard it):
//   joined ↔ (base, sibling)      : build / split          (1a, done)
//   joined ↔ (cmDoc, structure)   : toEditorModel / fromEditorModel (1b)
//   session-start = toEditorModel(build(base, sibling))
//   commit        = split(fromEditorModel(cmDoc, structure))
//   invariant     = split(fromEditorModel(toEditorModel(build(a,b)))) === (a,b)
//
// Finding recorded by this spike: pure RangeSet.map handles INTERIOR
// edits (the shipped failure mode) soundly. EMPTY ver-blocks (zero-width
// ranges, §1.8.a) cannot GROW by mapping alone — an insert at the point
// is claimed by neither/both adjacent ranges. Production needs explicit
// "active-block attribution" for the empty→non-empty transition; the
// last test probes this and shows the attribution fix.

import { describe, it, expect } from "vitest";
import {
  ChangeSet,
  EditorState,
  RangeSet,
  RangeValue,
} from "@codemirror/state";
import {
  build,
  split,
  LINE_TERMINATOR,
  VER_SEPARATOR,
} from "../../../src/diff2/joined-doc";

// ── editor-model representation ──────────────────────────────────────

type Role = "normal" | "ver1" | "ver2";

class Seg extends RangeValue {
  constructor(
    readonly role: Role,
    readonly group: number, // diff-group id; -1 for normal
  ) {
    super();
  }
  eq(other: RangeValue): boolean {
    return (
      other instanceof Seg &&
      other.role === this.role &&
      other.group === this.group
    );
  }
}

interface EditorModel {
  doc: string;
  structure: RangeSet<Seg>;
}

// joined string → (clean cmDoc, structure RangeSet). cmDoc is the joined
// string with all \0/\1 sentinels stripped; ranges tile the doc
// contiguously (the \n's live inside the ranges).
function toEditorModel(joined: string): EditorModel {
  let doc = "";
  const ranges: Array<{ from: number; to: number; value: Seg }> = [];
  let pos = 0;
  let group = 0;
  const lines = joined.split(LINE_TERMINATOR);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" && i === lines.length - 1) continue; // trailing
    const sep = line.indexOf(VER_SEPARATOR);
    if (sep === -1) {
      const text = line;
      ranges.push({ from: pos, to: pos + text.length, value: new Seg("normal", -1) });
      doc += text;
      pos += text.length;
    } else {
      const v1 = line.slice(0, sep);
      const v2 = line.slice(sep + 1);
      const g = group++;
      ranges.push({ from: pos, to: pos + v1.length, value: new Seg("ver1", g) });
      doc += v1;
      pos += v1.length;
      ranges.push({ from: pos, to: pos + v2.length, value: new Seg("ver2", g) });
      doc += v2;
      pos += v2.length;
    }
  }
  const structure = RangeSet.of(
    ranges.map((r) => r.value.range(r.from, r.to)),
    /* sort */ true,
  );
  return { doc, structure };
}

// (cmDoc, structure) → joined string (then split() inverts to base/sibling).
function fromEditorModel(model: EditorModel): string {
  const { doc, structure } = model;
  // Collect ranges in document order.
  const segs: Array<{ from: number; to: number; role: Role; group: number }> = [];
  const cur = structure.iter();
  while (cur.value) {
    segs.push({
      from: cur.from,
      to: cur.to,
      role: cur.value.role,
      group: cur.value.group,
    });
    cur.next();
  }
  let joined = "";
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.role === "normal") {
      joined += emitNormalLines(doc.slice(s.from, s.to));
    } else if (s.role === "ver1") {
      const v1 = doc.slice(s.from, s.to);
      // pair with the following ver2 of the same group.
      const next = segs[i + 1];
      const v2 = next && next.group === s.group ? doc.slice(next.from, next.to) : "";
      joined += v1 + VER_SEPARATOR + v2 + LINE_TERMINATOR;
      i++; // consume ver2
    }
  }
  return joined;
}

// local copy of joined-doc's private emitNormalLines (spike-only; the
// production refactor will export/share it).
function emitNormalLines(value: string): string {
  if (value === "") return "";
  let out = "";
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\n") {
      out += value.slice(start, i + 1) + LINE_TERMINATOR;
      start = i + 1;
    }
  }
  if (start < value.length) out += value.slice(start) + LINE_TERMINATOR;
  return out;
}

// Apply a change to the model: update doc + map structure through it.
function applyChange(
  model: EditorModel,
  spec: { from: number; to?: number; insert?: string },
): EditorModel {
  const state = EditorState.create({ doc: model.doc });
  const changes = state.changes(spec);
  const newDoc = changes.apply(state.doc).toString();
  const newStructure = model.structure.map(changes);
  return { doc: newDoc, structure: newStructure };
}

// Read the (from,to) of a given (role, group) from a structure.
function segOf(
  model: EditorModel,
  role: Role,
  group: number,
): { from: number; to: number } | null {
  const cur = model.structure.iter();
  while (cur.value) {
    if (cur.value.role === role && cur.value.group === group) {
      return { from: cur.from, to: cur.to };
    }
    cur.next();
  }
  return null;
}

// ── tests ────────────────────────────────────────────────────────────

describe("Rep A editor model — round-trip seam (no edits)", () => {
  const pairs: Array<[string, string, string]> = [
    ["one-change", "a\nb\nc\n", "a\nX\nc\n"],
    ["sibling-add", "a\nc\n", "a\nb\nc\n"],
    ["base-remove", "a\nb\nc\n", "a\nc\n"],
    ["multi-region", "a\nb\nc\nd\ne\n", "a\nB\nc\nD\ne\n"],
    ["no-eol", "a\nb", "a\nX"],
  ];
  for (const [name, base, sibling] of pairs) {
    it(`split∘fromEditorModel∘toEditorModel∘build === id: ${name}`, () => {
      const model = toEditorModel(build(base, sibling));
      const out = split(fromEditorModel(model));
      expect(out).toEqual({ base, sibling });
    });
  }
});

describe("Rep A editor model — split stays sound after FREE edits", () => {
  it("edit inside ver1 → base reflects, sibling intact", () => {
    const base = "a\nold\nc\n";
    const sibling = "a\nnew\nc\n";
    let model = toEditorModel(build(base, sibling));
    const v1 = segOf(model, "ver1", 0)!;
    // insert " X" at the end of ver1 content (interior of the range:
    // before its trailing \n).
    const insertAt = v1.to - 1; // just before "\n"
    model = applyChange(model, { from: insertAt, insert: "X" });
    const out = split(fromEditorModel(model));
    expect(out.base).toBe("a\noldX\nc\n");
    expect(out.sibling).toBe(sibling);
  });

  it("edit inside ver2 → sibling reflects, base intact", () => {
    const base = "a\nold\nc\n";
    const sibling = "a\nnew\nc\n";
    let model = toEditorModel(build(base, sibling));
    const v2 = segOf(model, "ver2", 0)!;
    model = applyChange(model, { from: v2.to - 1, insert: "Y" });
    const out = split(fromEditorModel(model));
    expect(out.base).toBe(base);
    expect(out.sibling).toBe("a\nnewY\nc\n");
  });

  it("edit inside a normal line → both sides reflect", () => {
    const base = "intro\nold\nc\n";
    const sibling = "intro\nnew\nc\n";
    let model = toEditorModel(build(base, sibling));
    // "intro" is the leading normal segment [0,6) = "intro\n".
    model = applyChange(model, { from: 5, insert: "!" }); // after "intro"
    const out = split(fromEditorModel(model));
    expect(out.base).toBe("intro!\nold\nc\n");
    expect(out.sibling).toBe("intro!\nnew\nc\n");
  });

  it("two sequential edits in different regions stay sound", () => {
    const base = "a\nb\nc\nd\ne\n";
    const sibling = "a\nB\nc\nD\ne\n";
    let model = toEditorModel(build(base, sibling));
    // group 0 = (b,B), group 1 = (d,D). Edit ver1 of group 0, then
    // ver2 of group 1.
    let v = segOf(model, "ver1", 0)!;
    model = applyChange(model, { from: v.to - 1, insert: "1" });
    v = segOf(model, "ver2", 1)!;
    model = applyChange(model, { from: v.to - 1, insert: "2" });
    const out = split(fromEditorModel(model));
    expect(out.base).toBe("a\nb1\nc\nd\ne\n");
    expect(out.sibling).toBe("a\nB\nc\nD2\ne\n");
  });
});

describe("Rep A editor model — empty ver-block (the fiddly case, §1.8.a)", () => {
  it("FINDING: pure RangeSet.map cannot grow an empty ver-block", () => {
    // sibling-only add → ver1 is empty (zero-width range).
    const base = "a\nc\n";
    const sibling = "a\nb\nc\n";
    const model = toEditorModel(build(base, sibling));
    const v1 = segOf(model, "ver1", 0)!;
    expect(v1.from).toBe(v1.to); // zero-width — empty ver-block
    // Insert "Q" exactly at that point and map.
    const mapped = applyChange(model, { from: v1.from, insert: "Q" });
    const v1After = segOf(mapped, "ver1", 0)!;
    // Pure mapping leaves ver1 still zero-width: the insert was NOT
    // attributed to it. This is the documented limitation.
    expect(v1After.from).toBe(v1After.to);
  });

  it("FIX: active-block attribution grows the edited empty ver-block", () => {
    const base = "a\nc\n";
    const sibling = "a\nb\nc\n";
    const model = toEditorModel(build(base, sibling));
    const v1 = segOf(model, "ver1", 0)!;
    const point = v1.from;

    // Apply the change to the doc, map everything, THEN explicitly
    // attribute the inserted span to the active block (ver1, group 0).
    // This is what the production transaction handler will do when the
    // caret is known to sit in an empty ver-block (§1.8.a entry).
    const state = EditorState.create({ doc: model.doc });
    const changes: ChangeSet = state.changes({ from: point, insert: "Q" });
    const newDoc = changes.apply(state.doc).toString();

    // Rebuild structure: map all ranges, then widen ver1/group0 to
    // cover the inserted text, shifting nothing else (the mapped ver2
    // already starts after the insert).
    const insLen = 1;
    const ranges: Array<{ from: number; to: number; value: Seg }> = [];
    const cur = model.structure.iter();
    while (cur.value) {
      const role = cur.value.role;
      const group = cur.value.group;
      if (role === "ver1" && group === 0) {
        ranges.push({ from: point, to: point + insLen, value: cur.value });
      } else {
        // Boundary rule: from→+1, to→−1 so a range does NOT grow at its
        // edges — an insert AT a boundary lands OUTSIDE, leaving the
        // active block (set explicitly above) as the sole owner. Interior
        // inserts still grow naturally. This is the production assoc rule.
        ranges.push({
          from: changes.mapPos(cur.from, 1),
          to: changes.mapPos(cur.to, -1),
          value: cur.value,
        });
      }
      cur.next();
    }
    const newStructure = RangeSet.of(
      ranges.map((r) => r.value.range(r.from, r.to)),
      true,
    );
    const out = split(fromEditorModel({ doc: newDoc, structure: newStructure }));
    expect(out.base).toBe("a\nQc\n"); // ver1 now "Q" → base side
    expect(out.sibling).toBe("a\nb\nc\n"); // ver2 ("b\n") unchanged
  });
});
