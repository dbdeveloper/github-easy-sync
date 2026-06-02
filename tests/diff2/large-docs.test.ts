// @vitest-environment happy-dom
//
// Large / long-line coverage gap (raised in review): every prior diff2 test
// used tiny docs (2–6 lines, 1–2 short ver-block lines). This exercises the
// MODEL layer with long lines (up to 200 chars), many lines per ver-block
// (up to 10), big docs (300 lines), and a seeded edit fuzz — all of which
// are unit-testable (no layout needed). The visual WRAP of a 200-char line
// at editor width ~30 is NOT testable in happy-dom (no layout) → Playwright
// / manual device check.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";
import {
  baseSiblingToModel,
  fromEditorModel,
  modelToBaseSibling,
  type EditorModel,
} from "../../src/diff2/editor-model";
import { buildDecorationSet, diffPaneStateField } from "../../src/diff2/decorations";
import { computeLineLabels } from "../../src/diff2/line-numbers";
import { EditorState, Text } from "@codemirror/state";

const LONG = (ch: string, n = 200) => ch.repeat(n);
const block = (ch: string, lines: number, len = 200) =>
  Array.from({ length: lines }, () => LONG(ch, len)).join("\n");

function tilesModel(m: EditorModel): boolean {
  const s = m.structure;
  if (s.length === 0) return m.doc.length === 0;
  if (s[0].from !== 0) return false;
  for (let i = 1; i < s.length; i++) if (s[i].from !== s[i - 1].to) return false;
  return s[s.length - 1].to === m.doc.length;
}

describe("large docs / long lines — model round-trip + tiling", () => {
  it("ver-block of 10 lines × 200 chars round-trips byte-exact", () => {
    const base = `intro\n${block("a", 10)}\noutro\n`;
    const sibling = `intro\n${block("b", 10)}\noutro\n`;
    const m = baseSiblingToModel(base, sibling);
    expect(tilesModel(m)).toBe(true);
    expect(modelToBaseSibling(m)).toEqual({ base, sibling });
  });

  it("asymmetric long ver-blocks (ver1 10 lines, ver2 1 line) round-trip", () => {
    const base = `x\n${block("a", 10)}\nz\n`;
    const sibling = `x\n${LONG("b")}\nz\n`;
    const m = baseSiblingToModel(base, sibling);
    expect(tilesModel(m)).toBe(true);
    expect(modelToBaseSibling(m)).toEqual({ base, sibling });
  });

  it("300-line doc with many alternating diff groups round-trips + tiles", () => {
    const baseLines: string[] = [];
    const sibLines: string[] = [];
    for (let i = 0; i < 300; i++) {
      const common = LONG(String.fromCharCode(97 + (i % 26)), 50);
      if (i % 7 === 0) {
        baseLines.push(LONG("L", 200));
        sibLines.push(LONG("R", 180));
      } else {
        baseLines.push(common);
        sibLines.push(common);
      }
    }
    const base = baseLines.join("\n") + "\n";
    const sibling = sibLines.join("\n") + "\n";
    const m = baseSiblingToModel(base, sibling);
    expect(tilesModel(m)).toBe(true);
    expect(modelToBaseSibling(m)).toEqual({ base, sibling });
  });
});

describe("large docs — render helpers do not throw", () => {
  it("buildDecorationSet + computeLineLabels handle a long multi-line ver-block", () => {
    const base = `intro\n${block("a", 10)}\noutro\n`;
    const sibling = `intro\n${block("b", 10)}\noutro\n`;
    const m = baseSiblingToModel(base, sibling);
    const doc = Text.of(m.doc.split("\n"));
    const opts = {
      oursLabel: "L",
      theirsLabel: "R",
      isMarkdown: false,
      callbacks: { onAction() {}, onActivateEmptyVer() {} },
    };
    expect(() => buildDecorationSet(doc, m.structure, opts)).not.toThrow();
    const labels = computeLineLabels(doc, m.structure);
    // one label per doc line; gutter array length matches.
    expect(labels.length).toBe(doc.lines);
    // intro is line 1.
    expect(labels[0]).toBe("1");
  });
});

describe("large docs — editing inside a long ver-block stays sound (live)", () => {
  let container: HTMLElement;
  let pane: DiffPane | null = null;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    pane?.destroy();
    pane = null;
    container.remove();
  });
  function tiles(p: DiffPane): boolean {
    const s = p.getView().state.field(diffPaneStateField, false)!.structure;
    const len = p.getView().state.doc.length;
    if (s.length === 0) return len === 0;
    if (s[0].from !== 0) return false;
    for (let i = 1; i < s.length; i++) if (s[i].from !== s[i - 1].to) return false;
    return s[s.length - 1].to === len;
  }

  it("insert in the middle of a 200-char ver1 line → base reflects, sibling intact", () => {
    const base = `x\n${LONG("a")}\nz\n`;
    const sibling = `x\n${LONG("b")}\nz\n`;
    pane = new DiffPane(container, base, sibling);
    const view = pane.getView();
    // middle of the "aaaa…" ver1 line.
    const at = view.state.doc.toString().indexOf("a") + 100;
    view.dispatch({ changes: { from: at, insert: "Z" } });
    expect(tiles(pane)).toBe(true);
    const out = pane.getResolved();
    expect(out.base).toBe(`x\n${LONG("a").slice(0, 100)}Z${LONG("a").slice(100)}\nz\n`);
    expect(out.sibling).toBe(sibling);
  });

  it("seeded fuzz: 250 interior edits on a multi-group doc keep tiling + commit sound", () => {
    const base = `${block("a", 4, 120)}\nmid\n${block("c", 4, 120)}\n`;
    const sibling = `${block("A", 4, 120)}\nmid\n${block("C", 4, 120)}\n`;
    pane = new DiffPane(container, base, sibling);
    const view = pane.getView();

    let seed = 0x1234abcd;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let step = 0; step < 250; step++) {
      const field = view.state.field(diffPaneStateField, false)!;
      // pick a NON-empty segment and a STRICTLY-interior position (so the
      // edit never crosses a ver boundary — that is what §1.7 forbids for
      // real users; here we exercise the sound, in-bounds editing path).
      const nonEmpty = field.structure.filter((s) => s.to - s.from >= 2);
      if (nonEmpty.length === 0) break;
      const seg = nonEmpty[Math.floor(rnd() * nonEmpty.length)];
      const interiorLo = seg.from + 1;
      const interiorHi = seg.to - 1;
      const pos = interiorLo + Math.floor(rnd() * (interiorHi - interiorLo + 1));
      const insert = rnd() < 0.5; // insert vs delete-1
      if (insert) {
        view.dispatch({ changes: { from: pos, insert: "qZ"[Math.floor(rnd() * 2)] } });
      } else {
        view.dispatch({ changes: { from: pos, to: pos + 1, insert: "" } });
      }
      // Invariant after EVERY chaotic edit: structure still tiles the doc,
      // and the commit reconstruction does not throw (no silent corruption).
      expect(tiles(pane)).toBe(true);
      expect(() => fromEditorModel({
        doc: view.state.doc.toString(),
        structure: view.state.field(diffPaneStateField, false)!.structure,
      })).not.toThrow();
    }
  });
});
