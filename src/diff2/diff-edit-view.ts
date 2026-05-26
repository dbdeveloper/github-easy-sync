// Diff-Edit widget — the host ItemView that Obsidian opens in a tab.
//
// Phase 1 ships:
//   - Sub-tabs header (Conflicts / Deleted).
//   - Conflicts list body (real, populated via synthetic-detector).
//   - Deleted body placeholder (Phase 9b).
//   - Detail-view placeholder reachable by clicking a conflict row;
//     `[←]` back arrow returns to list. The DiffPane itself lands in
//     Phase 2 — Phase 1's detail view is a stub that just shows the
//     selected (basePath, siblingPath).
//   - Subscribes to ConflictCounter so the list refreshes when the
//     vault changes (sibling create/delete/rename).
//
// Future phases:
//   Phase 2 — DiffPane render in detail view
//   Phase 3 — chunk-action buttons + group toolbar (resolve flow)
//   Phase 5 — autosave + recovery dialog on reopen
//   Phase 6 — entry-point hooks (file-menu, post-sync modal,
//             status-bar/ribbon click already wired to activateView
//             from main.ts)
//   Phase 7 — History list + restore
//   Phase 8 — Compare picker + compare-mode
//   Phase 9b — Deleted-mode UI + restore
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.0 (single-pane shell)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (conflicts list)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.7.5 (default sub-tab)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7 (DiffPane form — Phase 2)

import { ItemView, type Vault, WorkspaceLeaf } from "obsidian";
import type { ConflictCounter } from "../sync2/conflict-counter";
import type ConflictStore from "../sync2/conflict-store";
import { renderConflictsList } from "./conflicts-list";
import { DiffPane } from "./diff-pane";
import {
  DEFAULT_DIFF_EDIT_VIEW_STATE,
  DiffEditSubTab,
  DiffEditViewState,
} from "./events";
import { findAllConflicts, type ConflictEntry } from "./synthetic-detector";

export const DIFF2_EDIT_VIEW_TYPE = "diff2-edit-view";

export interface DiffEditViewDeps {
  vault: Vault;
  conflictStore: ConflictStore;
  conflictCounter: ConflictCounter;
}

// Phase 1 owns the navigation state machine inside the view: which
// sub-tab is active, and (when in detail mode) which entry the user
// drilled into. Future phases extend this with compare/history modes.
type Phase1ViewState =
  | { mode: "list"; tab: DiffEditSubTab }
  | { mode: "detail"; entry: ConflictEntry; tab: DiffEditSubTab };

function initialState(): Phase1ViewState {
  // R2.7.5 — default sub-tab is always Conflicts (deterministic UX
  // regardless of pending-count). Even when N === 0 the conflicts
  // tab opens; user must explicitly switch to Deleted.
  return { mode: "list", tab: "conflicts" };
}

export class DiffEditView extends ItemView {
  private viewState: Phase1ViewState = initialState();
  private readonly deps: DiffEditViewDeps;
  // Unsubscribe handle from ConflictCounter.subscribe — set on open,
  // called on close.
  private unsubscribeCounter: (() => void) | null = null;
  // Active DiffPane lives only while detail-mode is shown. Replaced
  // on every detail-open; destroyed when leaving detail-mode or on
  // view close.
  private activeDiffPane: DiffPane | null = null;

  constructor(leaf: WorkspaceLeaf, deps: DiffEditViewDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return DIFF2_EDIT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Diff-Edit";
  }

  getIcon(): string {
    return "git-merge";
  }

  // Phase 0 API kept for forward-compat. Phase 6 may use this to drop
  // the view straight into a particular sub-tab from external entry
  // points (file-menu, summary modal). Phase 1 ignores
  // compare/history shapes — they're stubbed out below.
  setDiffEditState(state: DiffEditViewState): void {
    if (state.kind === "sub-tab") {
      this.viewState = { mode: "list", tab: state.tab };
      this.render();
    }
    // compare-detail / history-detail not handled in Phase 1.
  }

  getDiffEditState(): DiffEditViewState {
    return this.viewState.mode === "list"
      ? { kind: "sub-tab", tab: this.viewState.tab }
      : { kind: "sub-tab", tab: this.viewState.tab };
  }

  async onOpen(): Promise<void> {
    // ConflictCounter notifies on any sibling-event vault change.
    // List-mode subscribers re-render; detail-mode just keeps showing
    // the active entry (refresh is a no-op for detail since the
    // selected sibling is stable until user clicks `[←]`).
    this.unsubscribeCounter = this.deps.conflictCounter.subscribe(() => {
      // Defer render to next microtask so multiple rapid changes
      // collapse into one re-render. Simple debounce; later phases
      // may upgrade to requestAnimationFrame if needed.
      queueMicrotask(() => this.render());
    });

    this.viewState = initialState();
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.unsubscribeCounter) {
      this.unsubscribeCounter();
      this.unsubscribeCounter = null;
    }
    this.disposeActiveDiffPane();
  }

  private disposeActiveDiffPane(): void {
    if (this.activeDiffPane) {
      this.activeDiffPane.destroy();
      this.activeDiffPane = null;
    }
  }

  // ── render dispatch ───────────────────────────────────────────────

  private render(): void {
    // Dispose any active DiffPane before tearing down its parent DOM —
    // CM6 EditorView.destroy() unhooks its own event listeners + DOM
    // children. If we just empty() the parent without destroy(), we
    // leak the listeners.
    this.disposeActiveDiffPane();

    const container = this.contentEl;
    container.empty();
    container.addClass("diff2-edit-view-root");

    if (this.viewState.mode === "list") {
      this.renderHeader(container, this.viewState.tab);
      this.renderListBody(container, this.viewState.tab);
    } else {
      this.renderDetail(container, this.viewState.entry);
    }
  }

  private renderHeader(parent: HTMLElement, activeTab: DiffEditSubTab): void {
    const header = parent.createDiv({ cls: "diff2-view-header" });
    const tabs: { id: DiffEditSubTab; label: string }[] = [
      { id: "conflicts", label: "Conflicts" },
      { id: "deleted", label: "Deleted" },
    ];
    for (const t of tabs) {
      const tabEl = header.createDiv({
        cls:
          `diff2-tab diff2-tab-${t.id}` +
          (t.id === activeTab ? " diff2-tab-active" : ""),
        text: t.label,
      });
      tabEl.style.cursor = "pointer";
      tabEl.addEventListener("click", () => {
        if (this.viewState.mode !== "list" || this.viewState.tab !== t.id) {
          this.viewState = { mode: "list", tab: t.id };
          this.render();
        }
      });
    }
  }

  private renderListBody(parent: HTMLElement, tab: DiffEditSubTab): void {
    const body = parent.createDiv({ cls: "diff2-view-body" });

    if (tab === "conflicts") {
      const { entries } = findAllConflicts(
        this.deps.vault,
        this.deps.conflictStore,
      );
      renderConflictsList(body, entries, {
        onEntryClick: (entry) => {
          this.viewState = { mode: "detail", entry, tab };
          this.render();
        },
      });
      return;
    }

    // tab === "deleted" — Phase 9b placeholder.
    body.createEl("p", {
      cls: "diff2-deleted-placeholder",
      text:
        "Deleted-mode UI lands in Phase 9b. See " +
        "docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.13 for the Phase 9b enumeration.",
    });
  }

  private renderDetail(parent: HTMLElement, entry: ConflictEntry): void {
    // Top toolbar — Phase 2 renders `[←]` back + entry identity.
    // Phase 3 adds group buttons; Phase 6 adds [Open in external tool].
    // The toggle for read-only/edit (R7.9b/c) only matters in
    // History / Compare modes — Conflicts is always editable.
    const toolbar = parent.createDiv({ cls: "diff2-detail-toolbar" });
    const back = toolbar.createSpan({
      cls: "diff2-back-arrow",
      text: "← Back to list",
    });
    back.style.cursor = "pointer";
    back.addEventListener("click", () => {
      this.viewState = { mode: "list", tab: "conflicts" };
      this.render();
    });
    const title = toolbar.createSpan({
      cls: "diff2-detail-title",
      text: ` ${entry.basePath}  ·  ${entry.deviceLabel} @ ${entry.isoTimestamp}`,
    });
    void title;

    // Detail body — DiffPane mount. Read both sides from vault
    // asynchronously, then construct the pane. Errors (e.g., file
    // disappeared between list-click and detail-render) fall back
    // to a Notice; we don't crash the view.
    const body = parent.createDiv({ cls: "diff2-detail-body" });
    void this.mountDiffPane(body, entry);
  }

  private async mountDiffPane(
    body: HTMLElement,
    entry: ConflictEntry,
  ): Promise<void> {
    const adapter = this.deps.vault.adapter;
    try {
      // Read both sides as text. Phase 2 supports text-only diff;
      // binary base files (e.g., images) will land in a later phase
      // with a "binary preview" detail variant — for now show error.
      let ours = "";
      const baseExists = await adapter.exists(entry.basePath);
      if (baseExists) {
        ours = await adapter.read(entry.basePath);
      }
      const theirs = await adapter.read(entry.siblingPath);

      // Stale-state guard: the view may have switched away while we
      // were awaiting reads. Bail without mounting if we're no
      // longer in detail mode for the same entry.
      if (
        this.viewState.mode !== "detail" ||
        this.viewState.entry.siblingPath !== entry.siblingPath
      ) {
        return;
      }
      // Same parent that called us must still be live — if user
      // clicked `[←]` mid-read, the body was emptied by render().
      // Check parent is still in the DOM.
      if (!body.isConnected) return;

      this.activeDiffPane = new DiffPane(body, ours, theirs, {
        oursLabel: "local",
        theirsLabel: entry.deviceLabel,
      });
    } catch (err) {
      body.createEl("p", {
        cls: "diff2-detail-error",
        text: `Failed to load diff: ${String(err)}`,
      });
    }
  }
}
