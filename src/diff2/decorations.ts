// DiffPane decoration extension — derives a DecorationSet from the
// editor-model structure (Segment[]) + the live doc (Stage 1b.1).
//
// Replaces the Phase-3 chunks/offsets side-field. The structure now
// lives in a StateField with TWO update paths (DIFF-EDITOR.md §1):
//   - `setDiffPaneState` effect → a chunk-action recomputed the
//     structure (roles changed: a resolved group became normal). Use
//     the effect's value verbatim.
//   - otherwise, on a doc change → `mapStructure(value, changes,
//     active)` maps POSITIONS only (never roles), so free editing stays
//     in sync. The shipped bug was having ONLY the effect path (free
//     edits desynced); a chunk action must NOT go through mapStructure
//     (it can't change roles), so it always dispatches the effect.
//
// Decorations produced (unchanged visuals, reused widgets/classes):
//   - Line backgrounds: red (ver1/ours), green (ver2/theirs), neutral.
//   - Word-level yellow marks from computeWordDiff (R7.4).
//   - Marker block-widgets <<<<< / ===== / >>>>> per diff group (R7.2).
//
// Built via Decoration.set(array, /*sort*/ true) rather than a
// RangeSetBuilder so decorations may be pushed in any order (word
// marks inside an early ver line vs a later line's background would
// otherwise violate the builder's sorted-input contract).
//
// Canonical specs:
//   - docs/tasks/DIFF-EDITOR.md §1 (model), §1.6.a.1 (markers as widgets)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.2–R7.5

import {
  ChangeDesc,
  Extension,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import {
  type ActiveBlock,
  growIndexFor,
  mapStructure,
  type Segment,
} from "./editor-model";
import { ConflictMarkerWidget, type MarkerWidgetCallbacks } from "./markers";
import { computeWordDiff } from "./word-level-diff";

export interface BuildOpts {
  oursLabel: string;
  theirsLabel: string;
  isMarkdown: boolean;
  callbacks: MarkerWidgetCallbacks;
}

const COMMON_LINE_CLASS = "diff2-line-common";
const OURS_LINE_CLASS = "diff2-line-ours";
const THEIRS_LINE_CLASS = "diff2-line-theirs";
const WORD_MARK_CLASS = "diff2-word-changed";

const lineCommon = Decoration.line({ class: COMMON_LINE_CLASS });
const lineOurs = Decoration.line({ class: OURS_LINE_CLASS });
const lineTheirs = Decoration.line({ class: THEIRS_LINE_CLASS });
const wordMark = Decoration.mark({ class: WORD_MARK_CLASS });

// §1.8.a temporary 1-line container shown when an empty ver-block is
// activated, so the caret has a visible spot to type into. Visual only —
// it adds no characters to the doc (the ver content stays "" until typed).
class EmptyVerActiveWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "diff2-empty-ver-active";
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

// §1.6.a.1 newline glyph — a ghost `↵` after a line's content marking its
// real \n. Not in the doc → not selectable, not copied. One shared
// instance (stateless; eq() always true so CM6 reuses DOM).
class NewlineGlyphWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "diff2-newline-glyph";
    el.textContent = "↵";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}
const NEWLINE_GLYPH = new NewlineGlyphWidget();

export interface DiffPaneFieldState {
  structure: Segment[];
  opts: BuildOpts;
  // §1.8.a: an explicitly-activated EMPTY ver-block (click on its marker,
  // or 1b.4b keyboard stop). Overrides the position heuristic so the next
  // typed char grows THIS block (a zero-width ver shares its position with
  // a neighbour, so the heuristic alone can't address it). null when no
  // empty ver is activated. Folded into this field (not a separate one)
  // so update() reads it atomically — no field-ordering trap.
  activeEmptyVer: ActiveBlock | null;
}

// Effect carrying a recomputed structure (chunk-action path). DiffPane
// dispatches this alongside the doc change in applyToChunk / resolveAll.
export const setDiffPaneState = StateEffect.define<DiffPaneFieldState>();

// Effect activating an empty ver-block (§1.8.a). DiffPane dispatches it
// with a caret placed at the block's point.
export const setActiveEmptyVer = StateEffect.define<ActiveBlock | null>();

// Locate a (group, role) block in a structure.
function blockOf(
  structure: Segment[],
  block: ActiveBlock,
): Segment | undefined {
  return structure.find(
    (s) => s.role === block.role && s.group === block.group,
  );
}

// The structure-of-record. See module header for the two update paths.
export const diffPaneStateField = StateField.define<DiffPaneFieldState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiffPaneState)) return e.value;
      if (e.is(setActiveEmptyVer) && value) {
        return { ...value, activeEmptyVer: e.value };
      }
    }
    if (!value) return value;

    if (tr.docChanged) {
      // Free-edit path: map positions only. The grown segment is the one the
      // edit belongs to — an explicitly activated empty ver (§1.8.a), else
      // the caret's segment (incl. normal segments, so an insert at a segment
      // boundary like doc-start grows the right segment instead of gapping).
      const growIdx = growIndexFor(
        value.structure,
        value.activeEmptyVer,
        tr.startState.selection.main.head,
      );
      const structure = mapStructure(
        value.structure,
        tr.changes as ChangeDesc,
        growIdx,
      );
      // Clear the activation once the block gains content — the heuristic
      // takes over from there (caret now sits strictly inside it).
      let activeEmptyVer = value.activeEmptyVer;
      if (activeEmptyVer) {
        const b = blockOf(structure, activeEmptyVer);
        if (!b || b.to !== b.from) activeEmptyVer = null;
      }
      return { structure, opts: value.opts, activeEmptyVer };
    }

    // Selection-only change: clear activation if the caret left the
    // activation point (a stale activation would misattribute later edits).
    if (value.activeEmptyVer && tr.selection) {
      const b = blockOf(value.structure, value.activeEmptyVer);
      if (!b || tr.newSelection.main.head !== b.from) {
        return { ...value, activeEmptyVer: null };
      }
    }
    return value;
  },
});

const decorationsProvider = EditorView.decorations.compute(
  [diffPaneStateField],
  (state) => {
    const field = state.field(diffPaneStateField);
    if (!field) return Decoration.none;
    return buildDecorationSet(
      state.doc,
      field.structure,
      field.opts,
      field.activeEmptyVer,
    );
  },
);

export function buildDecorationSet(
  doc: Text,
  structure: Segment[],
  opts: BuildOpts,
  activeEmptyVer: ActiveBlock | null = null,
): DecorationSet {
  const decos: ReturnType<typeof lineCommon.range>[] = [];
  const isActive = (group: number, role: "ver1" | "ver2"): boolean =>
    activeEmptyVer !== null &&
    activeEmptyVer.group === group &&
    activeEmptyVer.role === role;

  // Block widgets are only well-defined at a line boundary. In the EOL-less
  // edge where ver1 and ver2 share one cmDoc line (e.g. base "abc" /
  // sibling "XYZ" → "abcXYZ"), the middle marker's anchor is mid-line —
  // emitting a block widget there is undefined in CM6 (layout throw / bad
  // render, review finding C). Skip any block widget not at a line boundary;
  // the top/bottom markers (at the line's start/end) still frame the group.
  const pushBlock = (anchor: number, widget: WidgetType, side: number): void => {
    const line = doc.lineAt(anchor);
    if (anchor !== line.from && anchor !== line.to) return;
    decos.push(Decoration.widget({ widget, block: true, side }).range(anchor));
  };

  for (let i = 0; i < structure.length; i++) {
    const s = structure[i];

    if (s.role === "normal") {
      eachLineStart(doc, s.from, s.to, (from) =>
        decos.push(lineCommon.range(from)),
      );
      continue;
    }

    if (s.role !== "ver1") continue; // ver2 handled with its ver1
    const v1 = s;
    const v2 = structure[i + 1];
    if (!v2 || v2.role !== "ver2" || v2.group !== v1.group) continue;
    i++; // consume the paired ver2

    const v1Empty = v1.to <= v1.from;
    const v2Empty = v2.to <= v2.from;

    // Top marker — anchor at ver1 start, or ver2 start when ver1 empty
    // (zero-width point guard, mirrors the legacy anchor rule).
    const topAnchor = v1Empty ? v2.from : v1.from;
    pushBlock(
      topAnchor,
      new ConflictMarkerWidget(
        "top",
        opts.oursLabel,
        v1.group,
        opts.isMarkdown,
        opts.callbacks,
        v1Empty,
      ),
      -1,
    );

    // §1.8.a: an activated empty ver1 shows a temporary 1-line container.
    if (v1Empty && isActive(v1.group, "ver1")) {
      pushBlock(topAnchor, new EmptyVerActiveWidget(), -1);
    }

    // ver1 line backgrounds.
    eachLineStart(doc, v1.from, v1.to, (from) =>
      decos.push(lineOurs.range(from)),
    );

    // Middle marker — only when ver2 has content (legacy behavior).
    if (!v2Empty) {
      pushBlock(
        v2.from,
        new ConflictMarkerWidget(
          "middle",
          opts.theirsLabel,
          v1.group,
          opts.isMarkdown,
          opts.callbacks,
        ),
        -1,
      );
    }

    // §1.8.a: an activated empty ver2 shows a temporary 1-line container.
    if (v2Empty && isActive(v1.group, "ver2")) {
      pushBlock(v2.from, new EmptyVerActiveWidget(), -1);
    }

    // ver2 line backgrounds.
    eachLineStart(doc, v2.from, v2.to, (from) =>
      decos.push(lineTheirs.range(from)),
    );

    // Word-level marks on both sides.
    const oursText = doc.sliceString(v1.from, v1.to);
    const theirsText = doc.sliceString(v2.from, v2.to);
    const wd = computeWordDiff(oursText, theirsText);
    for (const span of wd.oursSpans) {
      const from = v1.from + span.start;
      const to = v1.from + span.end;
      if (to > from) decos.push(wordMark.range(from, to));
    }
    for (const span of wd.theirsSpans) {
      const from = v2.from + span.start;
      const to = v2.from + span.end;
      if (to > from) decos.push(wordMark.range(from, to));
    }

    // Bottom marker — below ver2, or below ver1 when ver2 empty.
    const bottomAnchor = v2Empty ? v1.to : v2.to;
    pushBlock(
      bottomAnchor,
      new ConflictMarkerWidget(
        "bottom",
        opts.theirsLabel,
        v1.group,
        opts.isMarkdown,
        opts.callbacks,
        v2Empty,
      ),
      1,
    );
  }

  // §1.6.a.1: a `↵` glyph at the end of every line that is followed by a
  // real \n — i.e. all lines except the last. Since line-wrap is always
  // on (§1.6.a.0), this disambiguates a hard line break from a soft wrap,
  // across the WHOLE document. The LAST line gets no glyph: its absence
  // signals "no trailing newline" (§1.2 last-line-of-file). Ghost only —
  // a widget, never part of the doc, so never selected or copied.
  for (let ln = 1; ln < doc.lines; ln++) {
    const line = doc.line(ln);
    decos.push(
      Decoration.widget({ widget: NEWLINE_GLYPH, side: 1 }).range(line.to),
    );
  }

  return Decoration.set(decos, /* sort */ true);
}

// Invoke `cb(lineStartPos)` for each doc line that the [from, to) range
// covers. Empty range (to <= from) → no lines. Lines are identified by
// their start position; callers add line decorations there.
function eachLineStart(
  doc: Text,
  from: number,
  to: number,
  cb: (lineFrom: number) => void,
): void {
  if (to <= from) return;
  let pos = from;
  while (pos < to) {
    const line = doc.lineAt(pos);
    cb(line.from);
    if (line.to + 1 > to) break;
    pos = line.to + 1; // next line start (skip the \n)
  }
}

// Public extension factory — seeds the field with the initial structure
// + opts, then layers the decoration provider.
export function diffPaneExtension(initial: DiffPaneFieldState): Extension {
  return [diffPaneStateField.init(() => initial), decorationsProvider];
}
