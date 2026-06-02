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

import { ItemView, Notice, type Vault, WorkspaceLeaf } from "obsidian";
import type SnapshotStore from "../sync2/snapshot-store";
import type { ConflictCounter } from "../sync2/conflict-counter";
import type ConflictStore from "../sync2/conflict-store";
import { renderConflictsList } from "./conflicts-list";
import { isMarkdownPath } from "./conflict-merge-all";
import { DiffPane } from "./diff-pane";
import {
  DEFAULT_DIFF_EDIT_VIEW_STATE,
  DiffEditSubTab,
  DiffEditViewState,
} from "./events";
import { executeExitProtocol } from "./exit-protocol";
import { findSentinelCollision } from "./joined-doc";
import { findAllConflicts, type ConflictEntry } from "./synthetic-detector";
import { renderConflictsToolbar } from "./toolbar-conflicts";

export const DIFF2_EDIT_VIEW_TYPE = "diff2-edit-view";

export interface DiffEditViewDeps {
  vault: Vault;
  conflictStore: ConflictStore;
  conflictCounter: ConflictCounter;
  // Snapshot store passed to atomicWriteFile so the post-write
  // recordSync step lines up with the snapshot's expectations.
  // Optional in test fixtures; required in production for
  // crash-safety per PSEUDO-MERGE-MODE.md §9.3 5-step protocol.
  snapshotStore?: SnapshotStore;
  // Local device label for the top-marker / "Keep all local
  // (<label>)" button text. Falls back to "local" when undefined.
  localDeviceLabel?: () => string;
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
    // R7.9a toolbar — [← Back] + group resolve buttons + Auto-advance
    // toggle. Phase 6 will add [Open in external tool] on the right
    // (desktop-only); Phase 5 may add an "unresolved chunks" footer.
    const isMd = isMarkdownPath(entry.basePath);
    const localLabel = this.deps.localDeviceLabel?.() ?? "local";
    const toolbar = parent.createDiv({ cls: "diff2-detail-toolbar" });

    renderConflictsToolbar(
      toolbar,
      { localLabel, remoteLabel: entry.deviceLabel },
      {
        onBack: () => {
          void this.exitDetailView(entry);
        },
        onKeepAllLocal: () => {
          this.activeDiffPane?.resolveAll("ours");
        },
        onApplyAllRemote: () => {
          this.activeDiffPane?.resolveAll("theirs");
        },
        onJoinAll: isMd
          ? () => {
              this.activeDiffPane?.resolveAll("join");
            }
          : undefined,
      },
    );

    // Title row under the toolbar — shows the conflict's identity so
    // the user always sees which file they're resolving.
    const titleRow = parent.createDiv({ cls: "diff2-detail-title-row" });
    titleRow.createEl("span", {
      cls: "diff2-detail-base-path",
      text: entry.basePath,
    });
    titleRow.createEl("span", {
      cls: "diff2-detail-meta",
      text: ` · ${entry.deviceLabel} @ ${entry.isoTimestamp}`,
    });

    // Detail body — DiffPane mount.
    const body = parent.createDiv({ cls: "diff2-detail-body" });
    void this.mountDiffPane(body, entry);
  }

  private async mountDiffPane(
    body: HTMLElement,
    entry: ConflictEntry,
  ): Promise<void> {
    const adapter = this.deps.vault.adapter;
    try {
      let ours = "";
      const baseExists = await adapter.exists(entry.basePath);
      if (baseExists) {
        ours = await adapter.read(entry.basePath);
      }
      const theirs = await adapter.read(entry.siblingPath);

      // Stale-state guard: bail if the user switched away during await.
      if (
        this.viewState.mode !== "detail" ||
        this.viewState.entry.siblingPath !== entry.siblingPath ||
        !body.isConnected
      ) {
        return;
      }

      // §1.3 fail-closed: a \0/\1 sentinel in either side is
      // incompatible with the internal joined-doc model. Don't open the
      // DiffPane; point the user at an alternative.
      const collision = findSentinelCollision(ours, theirs);
      if (collision) {
        new Notice(
          "This file contains a control character (SOH/NUL) incompatible " +
            "with the internal diff editor. Open it in your external diff " +
            "tool or the default Obsidian editor.",
        );
        body.createEl("p", {
          cls: "diff2-detail-error",
          text:
            `Cannot open diff: ${collision.side} contains a ` +
            `${collision.char === "VER_SEPARATOR" ? "SOH (U+0001)" : "NUL (U+0000)"} ` +
            "control character (§1.3 fail-closed).",
        });
        return;
      }

      this.activeDiffPane = new DiffPane(body, ours, theirs, {
        oursLabel: this.deps.localDeviceLabel?.() ?? "local",
        theirsLabel: entry.deviceLabel,
        isMarkdown: isMarkdownPath(entry.basePath),
        joinContext: {
          remoteDeviceLabel: entry.deviceLabel,
          timestamp: entry.isoTimestamp,
        },
      });
    } catch (err) {
      body.createEl("p", {
        cls: "diff2-detail-error",
        text: `Failed to load diff: ${String(err)}`,
      });
    }
  }

  // R7.7.c step 1 — write current buffer to vault base file.
  // R7.7.c step 2 (Phase 4) — proactive sibling cleanup: for each
  //   sibling with SHA(sibling) === SHA(base) the post-write,
  //   adapter.remove(siblingPath). Performed inside
  //   executeExitProtocol (src/diff2/exit-protocol.ts).
  // Step 4 (CM6 history null) is implicit when activeDiffPane is
  // disposed inside render(). Step 5 (close detail view) is the
  // `[←]` back-to-list transition done at the end of this method.
  // Step 3 (autosave cleanup) is Phase 5.
  private async exitDetailView(entry: ConflictEntry): Promise<void> {
    const pane = this.activeDiffPane;
    if (!pane) {
      this.viewState = { mode: "list", tab: "conflicts" };
      this.render();
      return;
    }

    try {
      // getResolvedBase() runs the commit-boundary fail-closed checks
      // (tiling assertion); keep it INSIDE the try so a thrown corruption
      // guard means "save failed, stay in the editor" rather than an
      // unhandled crash.
      const newOursText = pane.getResolvedBase();
      const result = await executeExitProtocol(
        { vault: this.deps.vault },
        entry.basePath,
        newOursText,
      );
      const cleaned = result.siblingsRemoved.length;
      const suffix =
        cleaned === 0
          ? ""
          : cleaned === 1
            ? " (1 redundant sibling cleaned)"
            : ` (${cleaned} redundant siblings cleaned)`;
      new Notice(`Saved ${entry.basePath}${suffix}`);
    } catch (err) {
      new Notice(`Failed to save ${entry.basePath}: ${String(err)}`);
      // Step 1 failed — stay in detail view so the user doesn't
      // lose work. Step 2 failures inside executeExitProtocol are
      // swallowed best-effort; only step 1 throws.
      return;
    }

    this.viewState = { mode: "list", tab: "conflicts" };
    this.render();
  }
}
