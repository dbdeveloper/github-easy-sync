// @vitest-environment happy-dom
//
// Save → reopen → resave stability (the user's "resolve some, leave some,
// reopen a week later" scenario). The metric build∘split==identity on the
// INTERNAL joined string does NOT hold (a chaotic edit can make `build`
// re-group chunks cosmetically) — but that is NOT the guarantee. The guarantee
// is on the FILES: by the §1.5 round-trip split(build(X))==X, the two saved
// files reopen to EXACTLY themselves. We prove it the way the app does it:
// reopen == mounting a fresh DiffPane on the saved files; getResolved again
// must return byte-identical files. No content loss, no conflict resurrection,
// no drift across reopens.

import { describe, it, expect, afterEach } from "vitest";
import { DiffPane } from "../../src/diff2/diff-pane";
import { diffPaneStateField, type BuildOpts } from "../../src/diff2/decorations";
import { build, split } from "../../src/diff2/joined-doc";

const OPTS: BuildOpts = { oursLabel: "l", theirsLabel: "r", isMarkdown: true, callbacks: {} as never };

function bigFiles() {
  const pad = (tag: string, i: number) => {
    const h = `${tag}-line-${i}-`;
    return h + "x".repeat(Math.max(1, 100 - h.length));
  };
  const baseLines: string[] = [];
  const sibLines: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const z = Math.floor(i / 50);
    const inZone = i >= z * 50 + 20 && i < z * 50 + 20 + (2 + (z % 9));
    if (inZone) {
      baseLines.push(pad(`BASE-z${z}`, i));
      sibLines.push(pad(`SIB-z${z}`, i));
    } else {
      const c = pad("COMMON", i);
      baseLines.push(c);
      sibLines.push(c);
    }
  }
  return { base: `${baseLines.join("\n")}\n`, sibling: `${sibLines.join("\n")}\n` };
}

const containers: HTMLElement[] = [];
function mount(base: string, sibling: string): DiffPane {
  const c = document.createElement("div");
  document.body.appendChild(c);
  containers.push(c);
  return new DiffPane(c, base, sibling, OPTS);
}

describe("save → reopen → resave is byte-stable (no drift)", () => {
  const panes: DiffPane[] = [];
  afterEach(() => {
    for (const p of panes) p.destroy();
    panes.length = 0;
    for (const c of containers) c.remove();
    containers.length = 0;
  });

  it("chaotic interior edits → §1.5 holds on the saved files, reopen returns identical files", () => {
    const { base, sibling } = bigFiles();

    for (let s = 0; s < 4; s++) {
      const pane1 = mount(base, sibling);
      panes.push(pane1);
      const view = pane1.getView();
      let seed = (0x1234abcd ^ (s * 2654435761)) & 0x7fffffff;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

      // Resolve a few groups, edit a ver, edit common — then leave the rest.
      for (let step = 0; step < 40; step++) {
        const struct = view.state.field(diffPaneStateField, false)!.structure;
        const nonEmpty = struct.filter((x) => x.to - x.from >= 2);
        if (nonEmpty.length === 0) break;
        const seg = nonEmpty[Math.floor(rnd() * nonEmpty.length)];
        const pos = seg.from + 1 + Math.floor(rnd() * (seg.to - 1 - (seg.from + 1) + 1));
        if (rnd() < 0.5) view.dispatch({ changes: { from: pos, insert: "qZ"[Math.floor(rnd() * 2)] } });
        else view.dispatch({ changes: { from: pos, to: pos + 1, insert: "" } });
      }

      // [← back] writes these two files.
      const files1 = pane1.getResolved();

      // §1.5 directly on the fuzzed result: split(build(files1)) === files1.
      const rt = split(build(files1.base, files1.sibling));
      expect(rt.base).toBe(files1.base);
      expect(rt.sibling).toBe(files1.sibling);

      // Reopen = mount a fresh DiffPane on the saved files (DiffPane does
      // build→toEditorModel internally). getResolved with NO edits must return
      // byte-identical files — what you saved is what you get back.
      const pane2 = mount(files1.base, files1.sibling);
      panes.push(pane2);
      const files2 = pane2.getResolved();
      expect(files2.base).toBe(files1.base);
      expect(files2.sibling).toBe(files1.sibling);

      // And once more (fixpoint — no slow drift across repeated reopens).
      const pane3 = mount(files2.base, files2.sibling);
      panes.push(pane3);
      const files3 = pane3.getResolved();
      expect(files3.base).toBe(files1.base);
      expect(files3.sibling).toBe(files1.sibling);
    }
  }, 60_000);
});
