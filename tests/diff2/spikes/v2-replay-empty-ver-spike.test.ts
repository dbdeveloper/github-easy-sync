// @vitest-environment happy-dom
//
// V2 GATE spike 1b (DIFF-EDITOR.md §0.4, ANALYSIS §3.1 + Фаза-1b).
//
// Question: in the V2 model, can the ver-block STRUCTURE be re-derived on
// history replay from the recorded ChangeSet ALONE (no stored structure, no
// `activeEmptyVer`) — specifically for the case the OLD gate-spike
// (`history-replay-structure-spike.test.ts`) proved BREAKS: typing into a
// formerly-EMPTY ver-block?
//
// Why it broke in the §1 model: an empty ver1 was a ZERO-WIDTH `Segment`
// (`from === to`); growth depended on `activeEmptyVer`/`growIndexFor` — info
// NOT in the ChangeSet — so change-only replay grew the wrong segment.
//
// V2's escape hatch: every ver-block carries a PROTECTED TERMINAL `\n`, so an
// empty ver is a REAL ≥1-width range covering that `\n` (NEVER zero-width).
// Modeled with the natural CM6 auto-mapping primitive — `Decoration.mark`
// with `inclusive: true` — typing into it should grow the SAME range purely
// via `DecorationSet.map(changes)`, deterministically, with no external hint.
//
// (This also settles the §2.2.2-vs-§2.2.4(1) ambiguity: §2.2.2's example
// `Range(7,7)` is zero-width and would re-break the old failure; §2.2.4(1)
// says the range POINTS AT / covers the terminal `\n` → ≥1 wide. This spike
// validates the §2.2.4(1) "terminal-inside" convention.)
//
// PASS ⇒ §2.6 "drop stored structure" is safe for the empty-ver-typing case.
// FAIL ⇒ V2 must persist structure in the block after all (like §1 format B).

import { describe, it, expect } from "vitest";
import { ChangeSet, RangeSet } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

// --- V2 model helpers (terminal-INSIDE convention) -------------------------
// A ver-block mark covers its content lines PLUS the protected terminal `\n`,
// so `doc[to-1] === '\n'` is always the terminal and the mark is never
// zero-width. content (what split writes) = doc.slice(from, to-1).
const ver = (n: 1 | 2, group: number): Decoration =>
  Decoration.mark({ inclusive: true, class: `v${n}g${group}` });

interface VerRange {
  from: number;
  to: number;
  cls: string;
}

function ranges(set: DecorationSet, docLen: number): VerRange[] {
  const out: VerRange[] = [];
  set.between(0, docLen, (from, to, v) => {
    out.push({ from, to, cls: (v.spec as { class: string }).class });
  });
  return out;
}

// §2.2.11 split, driven by the mark RangeSet: normal (gaps) → both sides;
// ver1 → base; ver2 → sibling; the terminal `\n` (last char of each mark) is
// internal → dropped from both.
function split(doc: string, rs: VerRange[]): { base: string; sibling: string } {
  let base = "";
  let sibling = "";
  let pos = 0;
  for (const r of rs) {
    if (r.from > pos) {
      const n = doc.slice(pos, r.from);
      base += n;
      sibling += n;
    }
    const content = doc.slice(r.from, r.to - 1); // drop terminal \n
    if (r.cls.startsWith("v1")) base += content;
    else sibling += content;
    pos = r.to;
  }
  if (pos < doc.length) {
    const n = doc.slice(pos);
    base += n;
    sibling += n;
  }
  return { base, sibling };
}

// Build the initial (doc, structure) for a single delete-vs-modify group:
//   base = "c\nd\n"   sibling = "c\nX\nd\n"   (ver1 EMPTY, ver2 = "X\n")
// doc layout (↵ = \n):  c ↵ ↵ X ↵ ↵ d ↵
//   offset:             0 1 2 3 4 5 6 7
//   normal "c\n"        [0,2)
//   ver1 EMPTY terminal [2,3)   (covers the lone \n at 2 → content "")
//   ver2 "X\n"+terminal [3,6)   (content "X\n", terminal \n at 5)
//   normal "d\n"        [6,8)
function initial(): { doc: string; structure: DecorationSet } {
  const doc = "c\n\nX\n\nd\n";
  const structure = RangeSet.of([ver(1, 0).range(2, 3), ver(2, 0).range(3, 6)]);
  return { doc, structure };
}

// The recorded change for "type Y into the empty ver1": the editor's §2.2.4(2)
// auto-`\n` normalization means the NET recorded change is insert "Y\n" at the
// empty ver's start (offset 2), turning ver1 from "" into "Y\n".
const TYPE_INTO_EMPTY = ChangeSet.of([{ from: 2, insert: "Y\n" }], "c\n\nX\n\nd\n".length);

describe("V2 gate 1b — empty-ver typing re-derives from change ALONE", () => {
  it("sanity: initial split reproduces the delete-vs-modify pair", () => {
    const { doc, structure } = initial();
    expect(split(doc, ranges(structure, doc.length))).toEqual({
      base: "c\nd\n",
      sibling: "c\nX\nd\n",
    });
  });

  it("LIVE: DecorationSet.map grows the empty ver1 over the typed text (no hint)", () => {
    const { structure } = initial();
    const mapped = structure.map(TYPE_INTO_EMPTY);
    const newDocStr = "c\nY\n\nX\n\nd\n"; // "Y\n" inserted at offset 2
    const rs = ranges(mapped, newDocStr.length);
    // ver1 must now cover "Y\n" + its terminal \n → [2,5); ver2 shifts by the
    // full insert length (+2) → [5,8). The empty ver GREW from a hint-free map.
    expect(rs).toEqual([
      { from: 2, to: 5, cls: "v1g0" },
      { from: 5, to: 8, cls: "v2g0" },
    ]);
    // and split it: ver1 became "Y\n" → modify-vs-modify, byte-exact.
    expect(split(newDocStr, rs)).toEqual({
      base: "c\nY\nd\n",
      sibling: "c\nX\nd\n",
    });
  });

  it("REPLAY == LIVE: fresh rebuild + ChangeSet-from-JSON reproduces identical structure", () => {
    const { structure } = initial();
    const live = ranges(structure.map(TYPE_INTO_EMPTY), "c\nY\n\nX\n\nd\n".length);

    // Replay path: rebuild structure from scratch (= from snapshots), then
    // re-apply the SAME change after a JSON round-trip (mirrors reading the
    // block back out of history.jsonl). NO activeEmptyVer anywhere.
    const rebuilt = initial(); // independent fresh build
    const csFromLog = ChangeSet.fromJSON(TYPE_INTO_EMPTY.toJSON());
    const replayed = ranges(rebuilt.structure.map(csFromLog), "c\nY\n\nX\n\nd\n".length);

    expect(replayed).toEqual(live); // determinism — the gate
    expect(split("c\nY\n\nX\n\nd\n", replayed)).toEqual(split("c\nY\n\nX\n\nd\n", live));
  });

  it("control: typing into the NON-empty ver2 also re-derives from change alone", () => {
    const { doc, structure } = initial();
    // insert "Z" inside ver2's content (before its \n at offset 4): "X" → "XZ"
    const cs = ChangeSet.of([{ from: 4, insert: "Z" }], doc.length);
    const mapped = structure.map(cs);
    const newDocStr = "c\n\nXZ\n\nd\n";
    expect(split(newDocStr, ranges(mapped, newDocStr.length))).toEqual({
      base: "c\nd\n",
      sibling: "c\nXZ\nd\n",
    });
  });
});
