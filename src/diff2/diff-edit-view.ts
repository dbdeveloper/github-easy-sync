// Diff-Edit widget — the host ItemView that Obsidian opens in a tab.
// Phase 0 ships only the scaffolding: view registers with workspace,
// `Open Diff-Edit` command opens an empty tab, contentEl renders a
// placeholder. Future phases populate contentEl with:
//
//   Phase 1 — sub-tabs header (Conflicts / Deleted) + list-view body
//   Phase 2 — DiffPane (CM6 unified merge view) for detail
//   Phase 3 — chunk-action buttons + group toolbar (resolve flow)
//   Phase 5 — autosave + recovery dialog on reopen
//   Phase 6 — entry-point wiring (file-menu, status-bar click,
//             ribbon click, summary modal)
//   Phase 7 — History list + Restore-this-version
//   Phase 8 — Compare picker + compare-mode
//   Phase 9b — Deleted-mode UI + restore
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.0 (single-pane shell)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7 (DiffPane form)
//
// The view type ID is used by Obsidian's workspace to dispatch
// setViewState({type: ...}) calls back to this class via the
// factory registered in main.ts::onload.

import { ItemView, WorkspaceLeaf } from "obsidian";
import { DEFAULT_DIFF_EDIT_VIEW_STATE, DiffEditViewState } from "./events";

export const DIFF2_EDIT_VIEW_TYPE = "diff2-edit-view";

export class DiffEditView extends ItemView {
  // State is settable by command callers before / after setViewState
  // so they can drop the view straight into a particular sub-tab or
  // detail session. Phase 0 ignores transitions; Phase 1+ acts on them.
  private state: DiffEditViewState = DEFAULT_DIFF_EDIT_VIEW_STATE;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return DIFF2_EDIT_VIEW_TYPE;
  }

  getDisplayText(): string {
    // Title shown in the tab header. Later phases may vary by state
    // (e.g., "Diff-Edit · Conflicts" / "Diff-Edit · history of note.md").
    return "Diff-Edit";
  }

  getIcon(): string {
    // Matches the ribbon icon convention from R2.7.4.
    return "git-merge";
  }

  // Public state-setter — Phase 0 stores but doesn't render-react.
  // Later phases call requestRefresh()/re-render in response.
  setDiffEditState(state: DiffEditViewState): void {
    this.state = state;
  }

  getDiffEditState(): DiffEditViewState {
    return this.state;
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("diff2-edit-view-root");

    // Phase 0 placeholder. Replaced by Phase 1's sub-tabs header +
    // list router; Phase 2+ adds DiffPane and toolbars.
    const header = container.createDiv({ cls: "diff2-placeholder-header" });
    header.createEl("h3", { text: "Diff-Edit" });
    header.createEl("p", {
      text:
        "Scaffolding only (Phase 0). The conflicts list, deleted list, " +
        "history, compare, and unified DiffPane land in later phases — " +
        "see docs/DIFF2_IMPLEMENTATION_PLAN.md §R12 for sequencing.",
      cls: "diff2-placeholder-text",
    });
  }

  async onClose(): Promise<void> {
    // Phase 0 has nothing to tear down. Phase 5 will clean up
    // autosave throttles + write last buffer snapshot here; Phase 6
    // will fire the DetailViewClose event consumed by the last-tab-
    // close hook (R3.7 invariant via trashStore.resetLifts()).
  }
}
