// @vitest-environment happy-dom
//
// Stage 3b — large-document replay stress test.
//
// ~100 KB / 1000 lines (~100 chars each), a 2–10 line conflict zone every 50
// lines → 20 conflict groups. Exercises, with >500 ms emulated gaps between
// ops and replay==live byte-exact recovery + split-correctness:
//   - 10 edits to ordinary lines        → must land in BOTH files;
//   - resolve HALF the conflicts two ways:
//       (1) via ver1 ("ours") chunk-action            → BOTH files;
//       (2) ver2 PRE-EDIT (replace 2nd-from-last line) THEN resolve to ver2
//           (theirs) — the tricky case                → BOTH files;
//   - ver2-only edits on unresolved groups (no resolve) → SECOND file ONLY.
// (The free-edit Variant-3 replacement resolution is a CONFIRMED separate bug —
// see free-edit-resolve-bug.test.ts [skipped] + DIFF-EDITOR.md §1.7.a (0).)

import { describe, it, expect } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { DiffPane, structureHistory } from "../../src/diff2/diff-pane";
import {
  diffPaneExtension,
  diffPaneStateField,
  setDiffPaneState,
  type BuildOpts,
} from "../../src/diff2/decorations";
import {
  baseSiblingToModel,
  fromEditorModel,
  type Segment,
} from "../../src/diff2/editor-model";
import { split } from "../../src/diff2/joined-doc";
import { serializeHistoryBlock } from "../../src/diff2/history-log";
import { replayHistory } from "../../src/diff2/history-replay";

const OPTS: BuildOpts = {
  oursLabel: "local",
  theirsLabel: "remote",
  isMarkdown: true,
  callbacks: {} as never,
};

// ── document generator ───────────────────────────────────────────────

const N_LINES = 1000;
const ZONE_EVERY = 50;
const ZONE_OFFSET = 20; // conflict starts 20 lines into each 50-line block

function pad(tag: string, i: number): string {
  const head = `${tag}-line-${i}-`;
  return head + "x".repeat(Math.max(1, 100 - head.length));
}
function zoneOf(i: number): { z: number; inZone: boolean } {
  const z = Math.floor(i / ZONE_EVERY);
  const start = z * ZONE_EVERY + ZONE_OFFSET;
  const len = 2 + (z % 9); // 2..10
  return { z, inZone: i >= start && i < start + len };
}
function buildFiles(): { base: string; sibling: string; groups: number } {
  const baseLines: string[] = [];
  const sibLines: string[] = [];
  for (let i = 0; i < N_LINES; i++) {
    const { z, inZone } = zoneOf(i);
    if (inZone) {
      baseLines.push(pad(`BASE-z${z}`, i));
      sibLines.push(pad(`SIB-z${z}`, i));
    } else {
      const common = pad("COMMON", i);
      baseLines.push(common);
      sibLines.push(common);
    }
  }
  return {
    base: `${baseLines.join("\n")}\n`,
    sibling: `${sibLines.join("\n")}\n`,
    groups: Math.ceil(N_LINES / ZONE_EVERY),
  };
}

// ── replay helpers (mirror history-replay.test) ──────────────────────

interface RawBlock {
  change: unknown;
  structure: Segment[];
}
function toJsonl(blocks: RawBlock[]): string {
  return blocks
    .map((b, i) => serializeHistoryBlock(i + 1, `t${i + 1}`, b.change, b.structure))
    .join("\n");
}
function replayStartState(base: string, sibling: string): EditorState {
  const initial = baseSiblingToModel(base, sibling);
  return EditorState.create({
    doc: initial.doc,
    extensions: [
      diffPaneExtension({ structure: initial.structure, opts: OPTS, activeEmptyVer: null }),
      history({ newGroupDelay: 0 }),
      structureHistory,
      keymap.of(historyKeymap),
    ],
  });
}
const structOf = (s: EditorState) => s.field(diffPaneStateField)!.structure;
function resolvedOf(s: EditorState): { base: string; sibling: string } {
  const { base, sibling } = split(fromEditorModel({ doc: s.doc.toString(), structure: structOf(s) }));
  return { base: base === "" ? "\n" : base, sibling: sibling === "" ? "\n" : sibling };
}
const segFor = (st: Segment[], role: "ver1" | "ver2", g: number) =>
  st.find((s) => s.role === role && s.group === g)!;

describe("Stage 3b — large-doc replay stress (mixed resolutions)", () => {
  it("recovers a 100 KB / 20-group doc with half resolved two ways — EXACTLY", () => {
    const { base, sibling, groups } = buildFiles();
    expect(base.length).toBeGreaterThan(90_000); // ~100 KB

    const container = document.createElement("div");
    document.body.appendChild(container);
    const pane = new DiffPane(container, base, sibling, OPTS);
    const view = pane.getView();

    // Sanity: build produced one group per conflict zone.
    const initialGroups = new Set(structOf(view.state).filter((s) => s.role === "ver1").map((s) => s.group));
    expect(initialGroups.size).toBe(groups);

    // Capture every recordable transaction (format B: change + post-tx structure).
    const blocks: RawBlock[] = [];
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((u) => {
          for (const tr of u.transactions) {
            if (!tr.docChanged && !tr.effects.some((e) => e.is(setDiffPaneState))) continue;
            blocks.push({
              change: tr.changes.toJSON(),
              structure: u.state.field(diffPaneStateField)!.structure,
            });
          }
        }),
      ),
    });

    // Emulate a real user pausing >500 ms between operations WITHOUT real
    // waiting: CM6 history derives a transaction's time from Date.now(), so
    // advancing a controlled clock by >newGroupDelay makes each operation a
    // distinct edit event (and internal applyToChunk dispatches too — they
    // read the same Date.now). Frozen-then-stepped clock; no fake timers, so
    // happy-dom rendering/rAF is untouched. Restored in finally.
    const realDateNow = Date.now;
    let clock = 1_700_000_000_000;
    Date.now = () => clock;
    const pause = (ms = 510) => {
      clock += ms;
    };

    // 10 common lines to edit (off = i%50 < 20 ⇒ outside any conflict zone).
    const NORMAL_TARGETS = [3, 105, 205, 305, 405, 505, 605, 705, 805, 905];
    // Unresolved groups to edit "just because" (ver2-only, no resolve).
    const VER2_ONLY = [18, 16, 14, 12, 10];
    const half = Math.floor(groups / 2); // resolve groups 0..half-1

    try {
      // (1) Random-ish edits to ordinary lines → must land in BOTH files.
      for (const i of NORMAL_TARGETS) {
        pause();
        const needle = `COMMON-line-${i}-`;
        const at = view.state.doc.toString().indexOf(needle);
        expect(at).toBeGreaterThanOrEqual(0);
        view.dispatch({ changes: { from: at + needle.length, insert: `NORMEDIT${i}` } });
      }

      // (2) Resolve the first half, DESCENDING so editing a higher-position
      // group never shifts a not-yet-processed lower one.
      for (let g = half - 1; g >= 0; g--) {
        pause();
        if (g % 2 === 0) {
          // Method 1 — resolve via ver1 ("ours") chunk-action → BOTH files get
          // ver1 content. (The free-edit-replacement resolution path — §1.7
          // Variant 3 — is a CONFIRMED separate bug; see the skipped
          // free-edit-resolve-bug regression + DIFF-EDITOR.md §1.7.a (0).)
          pane.applyToChunk(g, "ours");
        } else {
          // Method 2 — edit the ver2 block (replace its 2nd-from-last line),
          // THEN resolve to ver2. Resolved ⇒ goes to BOTH files. The tricky case.
          const st = structOf(view.state);
          const v2 = segFor(st, "ver2", g);
          const lines = view.state.doc.sliceString(v2.from, v2.to).split("\n");
          const targetIdx = Math.max(0, lines.length - 2);
          let lineStart = v2.from;
          for (let k = 0; k < targetIdx; k++) lineStart += lines[k].length + 1;
          const lineEnd = lineStart + lines[targetIdx].length;
          view.dispatch({ changes: { from: lineStart, to: lineEnd, insert: `VER2-EDIT-g${g}` } });
          pause(); // >500 ms between the ver2 pre-edit and the resolve
          pane.applyToChunk(g, "theirs");
        }
      }

      // (3) Edit ver2 of some UNRESOLVED groups "just because" (no resolve) →
      // must land ONLY in the second (sibling) file.
      for (const g of VER2_ONLY) {
        pause();
        const v2 = segFor(structOf(view.state), "ver2", g);
        view.dispatch({ changes: { from: v2.from + 2, insert: `VER2ONLY-g${g}` } });
      }
    } finally {
      Date.now = realDateNow;
    }

    const liveResolved = pane.getResolved();

    // Half resolved ⇒ half still unresolved (ver2-only edits don't resolve).
    const remaining = new Set(structOf(view.state).filter((s) => s.role === "ver1").map((s) => s.group));
    expect(remaining.size).toBe(groups - half);

    pane.destroy();
    container.remove();

    // ── Replay: byte-exact recovery of BOTH sides ──
    const jsonl = toJsonl(blocks);
    const r = replayHistory(replayStartState(base, sibling), jsonl);
    expect(r.stoppedAtCorrupt).toBe(false);
    expect(r.replayed).toBe(blocks.length);
    const replayed = resolvedOf(r.state);
    expect(replayed.base).toBe(liveResolved.base);
    expect(replayed.sibling).toBe(liveResolved.sibling);

    // ── Split correctness (verified on the live result, carried by replay) ──
    // Ordinary-line edits → BOTH files.
    for (const i of NORMAL_TARGETS) {
      expect(liveResolved.base).toContain(`NORMEDIT${i}`);
      expect(liveResolved.sibling).toContain(`NORMEDIT${i}`);
    }
    // Method-1 ver1 ("ours") resolution (even g) → ver1 content in BOTH files.
    for (let g = 0; g < half; g += 2) {
      expect(liveResolved.base).toContain(`BASE-z${g}`);
      expect(liveResolved.sibling).toContain(`BASE-z${g}`);
      expect(liveResolved.base).not.toContain(`SIB-z${g}`); // ver2 dropped
    }
    // Method-2 ver2 pre-edit + resolve (odd g) → resolved → BOTH files.
    for (let g = 1; g < half; g += 2) {
      expect(liveResolved.base).toContain(`VER2-EDIT-g${g}`);
      expect(liveResolved.sibling).toContain(`VER2-EDIT-g${g}`);
    }
    // ver2-only edits (no resolve) → SECOND file only.
    for (const g of VER2_ONLY) {
      expect(liveResolved.sibling).toContain(`VER2ONLY-g${g}`);
      expect(liveResolved.base).not.toContain(`VER2ONLY-g${g}`);
    }
  }, 30_000); // heavy: 100 KB doc + 25 CM6 ops in happy-dom + replay; >5 s under full-suite load
});
