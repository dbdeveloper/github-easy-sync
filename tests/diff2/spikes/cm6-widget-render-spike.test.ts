// @vitest-environment happy-dom
//
// R12.0 Spike 1 — CM6 widget rendering under vitest/JSDOM.
//
// Question (DIFF2_IMPLEMENTATION_PLAN.md §R12.0):
//   Does `Decoration.widget` from @codemirror/view render its DOM
//   correctly under vitest's JSDOM environment via mock-obsidian.ts?
//
// Why it matters:
//   Phase 2 of the diff-edit subproject renders <<<<< / ===== / >>>>>
//   marker block-widgets as `Decoration.widget` decorations on top of
//   the merged document buffer. If the widget node never lands in the
//   DOM tree under vitest, Phase 2 acceptance tests (and Phases 3/4/5)
//   cannot be written as unit tests — they'd need Playwright.
//
// Expected outcome (PASS):
//   EditorView mounts under JSDOM, widget decoration adds a DOM node
//   that we can query and verify.
//
// Fallback (FAIL — widget DOM doesn't render or update):
//   Phase 2/3/4/5 testing migrates to a separate Playwright suite.
//   The acceptance criterion for Phase 2 shifts from "vitest unit tests
//   for widget rendering" to "Playwright integration tests".

import { describe, it, expect } from "vitest";
import { EditorState, StateField, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

class MarkerWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: MarkerWidget): boolean {
    return other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "diff2-marker";
    span.textContent = this.label;
    return span;
  }
}

// StateField that emits one widget after the first line break, mimicking
// the shape Phase 2 will build for <<<<< / ===== / >>>>> markers.
const markerField = StateField.define<DecorationSet>({
  create(state) {
    const builder = new RangeSetBuilder<Decoration>();
    const firstNewline = state.doc.toString().indexOf("\n");
    if (firstNewline >= 0) {
      builder.add(
        firstNewline + 1,
        firstNewline + 1,
        Decoration.widget({
          widget: new MarkerWidget("<<<<<"),
          block: true,
          side: -1,
        }),
      );
    }
    return builder.finish();
  },
  update(value, tr) {
    return value.map(tr.changes);
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

describe("R12.0 Spike 1 — CM6 widget rendering under JSDOM", () => {
  it("EditorView mounts and renders Decoration.widget under JSDOM", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      state: EditorState.create({
        doc: "line one\nline two\nline three\n",
        extensions: [markerField],
      }),
      parent,
    });

    try {
      // Force a measure cycle — CM6 sometimes defers widget mounting
      // until after the first measurement pass.
      view.requestMeasure();

      const widgets = parent.querySelectorAll(".diff2-marker");
      // The expectation is exactly one widget. If JSDOM doesn't run the
      // view-update cycle, this will be 0.
      expect(widgets.length).toBe(1);
      expect(widgets[0]?.textContent).toBe("<<<<<");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("widget DOM updates when document changes", () => {
    // Verify view-update cycle re-runs the StateField mapper. If it
    // doesn't, decorations don't track edits and Phase 2 can't rely on
    // marker positions staying correct across user edits.
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      state: EditorState.create({
        doc: "first\nsecond\n",
        extensions: [markerField],
      }),
      parent,
    });

    try {
      view.requestMeasure();
      expect(parent.querySelectorAll(".diff2-marker").length).toBe(1);

      // Insert a character at the start — widget should still mount,
      // possibly at a different doc offset.
      view.dispatch({ changes: { from: 0, insert: "X" } });
      view.requestMeasure();
      expect(parent.querySelectorAll(".diff2-marker").length).toBe(1);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
