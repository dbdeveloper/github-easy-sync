import { ItemView, WorkspaceLeaf } from "obsidian";
import ConflictStore, {
  ConflictRecord,
} from "../conflict-store";
import { DiffPane } from "./diff-pane";
import { formatTs, groupByVaultPath } from "./conflict-view-helpers";

// Re-export for backwards-compatible imports.
export { formatTs, groupByVaultPath };

// Workspace leaf type identifier — registered in main.ts via
// plugin.registerView(VIEW_TYPE_SYNC2_CONFLICT, ...).
export const VIEW_TYPE_SYNC2_CONFLICT = "sync2-conflict-view";

// ItemView orchestrator (Etap 6.5). Layout:
//
//   ┌─ Conflicts (N) ─────────┐ ┌─ <selected file> ──────────────┐
//   │ ▼ note.md  (2 versions) │ │   OURS               THEIRS    │
//   │   • Phone 15:30 [▶]     │ │  ───────────────── ─────────── │
//   │   • Tablet 18:00        │ │   <diff-pane>                  │
//   │ ▶ todo.md (1)           │ │                                │
//   └─────────────────────────┘ └────────────────────────────────┘
//
// The list groups conflict records by vaultPath so a file with N
// deferred copies appears once with N children. Clicking a child
// opens the diff for that specific (ours-on-disk vs that copy).
//
// On byte-equality (auto-finalize), the resolved content is written
// to the original `vaultPath` and the matching ConflictStore record
// is dropped. Other deferred copies for the same file remain in the
// list — user can iterate through them pair-by-pair.

export interface ConflictViewDeps {
  conflictStore: ConflictStore;
  // Hook called whenever the view resolves a conflict (auto-finalize
  // or user-driven). main.ts uses it to refresh the status-bar
  // counter and trigger a sync after the in-flight resolution is
  // done — sync2 picks up the unblocked path on the next call.
  onConflictResolved?(record: ConflictRecord): void;
  // Reads the live ours content from the vault. Plumbed from main.ts
  // so the view doesn't reach into Vault directly.
  readOurs(vaultPath: string): Promise<string>;
  // Writes the resolved content to the live ours file. Etap 6.6
  // canonicalisation already happens upstream in writeRemoteText
  // when sync2 owns the write; here the user already produced the
  // final form via the diff editor, so we pass through.
  writeResolved(vaultPath: string, content: string): Promise<void>;
}

export class ConflictView extends ItemView {
  private deps: ConflictViewDeps | null = null;
  private listEl: HTMLElement | null = null;
  private paneEl: HTMLElement | null = null;
  private currentDiff: DiffPane | null = null;

  // Read-only accessor for the live DiffPane (or null when the user
  // hasn't selected a conflict yet). main.ts reaches in here from
  // the Obsidian command-palette wrappers to drive nextChunk /
  // applyAtCursor — same operations the keymap inside the editor
  // performs, but reachable from vim-mode and other external
  // bindings.
  getCurrentDiff(): DiffPane | null {
    return this.currentDiff;
  }
  private selectedRecordId: string | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  // Late wire-up — main.ts calls setDeps once after registering the
  // view. The two-step init keeps the constructor signature simple
  // (Obsidian's plugin.registerView passes only the leaf).
  setDeps(deps: ConflictViewDeps): void {
    this.deps = deps;
    this.refreshList();
  }

  getViewType(): string {
    return VIEW_TYPE_SYNC2_CONFLICT;
  }

  getDisplayText(): string {
    return "Sync conflicts";
  }

  getIcon(): string {
    return "merge"; // Lucide merge icon — visually distinct from sync's refresh-cw
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("sync2-conflict-view");

    // Two-pane layout: list on the left, diff on the right.
    const wrapper = root.createDiv({ cls: "sync2-conflict-view-wrapper" });
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "row";
    wrapper.style.height = "100%";

    this.listEl = wrapper.createDiv({ cls: "sync2-conflict-list" });
    this.listEl.style.minWidth = "240px";
    this.listEl.style.maxWidth = "320px";
    this.listEl.style.borderRight = "1px solid var(--background-modifier-border)";
    this.listEl.style.padding = "8px";
    this.listEl.style.overflowY = "auto";

    this.paneEl = wrapper.createDiv({ cls: "sync2-conflict-pane" });
    this.paneEl.style.flex = "1";
    this.paneEl.style.padding = "8px";
    this.paneEl.style.overflow = "hidden";

    if (this.deps) this.refreshList();
  }

  async onClose(): Promise<void> {
    if (this.currentDiff) {
      this.currentDiff.destroy();
      this.currentDiff = null;
    }
  }

  // Re-render the left-side list against current ConflictStore state.
  // Called: on view open, when setDeps fires, and externally from
  // main.ts after sibling-delete or auto-finalize closes a record.
  refreshList(): void {
    if (!this.listEl || !this.deps) return;
    this.listEl.empty();

    const grouped = groupByVaultPath(this.deps.conflictStore.list());
    const totalCount = this.deps.conflictStore.list().length;

    this.listEl.createEl("h4", { text: `Conflicts (${totalCount})` });
    if (totalCount === 0) {
      this.listEl.createEl("p", {
        text: "No pending conflicts. Sync2 is clean.",
        cls: "sync2-empty-state",
      });
      this.clearPane();
      return;
    }

    for (const [vaultPath, records] of grouped) {
      const fileItem = this.listEl.createDiv({ cls: "sync2-conflict-file" });
      fileItem.createEl("strong", {
        text:
          records.length > 1
            ? `${vaultPath}  (${records.length} versions)`
            : vaultPath,
      });
      const childList = fileItem.createDiv({
        cls: "sync2-conflict-children",
      });
      childList.style.marginLeft = "12px";
      for (const r of records) {
        const child = childList.createDiv({
          cls: "sync2-conflict-child",
        });
        child.style.cursor = "pointer";
        child.style.padding = "4px 0";
        const isSelected = this.selectedRecordId === r.id;
        if (isSelected) {
          child.style.fontWeight = "bold";
          child.style.color = "var(--text-accent)";
        }
        child.setText(`• vs ${r.deviceLabel} ${formatTs(r.ts)}`);
        child.addEventListener("click", () => {
          void this.openDiffFor(r);
        });
      }
    }
  }

  // ── internal ────────────────────────────────────────────────────────

  private async openDiffFor(record: ConflictRecord): Promise<void> {
    if (!this.deps || !this.paneEl) return;
    this.selectedRecordId = record.id;
    this.refreshList();
    this.clearPane();

    const ours = await this.deps.readOurs(record.vaultPath);
    const theirs = await this.deps.conflictStore.readTheirs(record.id);

    // Header strip at the top of the pane: which file, which copy.
    const header = this.paneEl.createDiv({ cls: "sync2-diff-header" });
    header.style.padding = "4px 8px";
    header.style.borderBottom =
      "1px solid var(--background-modifier-border)";
    header.createEl("strong", {
      text: `${record.vaultPath}  vs  ${record.deviceLabel} ${formatTs(record.ts)}`,
    });

    const diffHost = this.paneEl.createDiv({ cls: "sync2-diff-host" });
    diffHost.style.height = "calc(100% - 36px)";

    this.currentDiff = new DiffPane(diffHost, {
      path: record.vaultPath,
      oursText: ours,
      theirsText: theirs,
      onByteEqual: async (finalText) => {
        if (!this.deps) return;
        // Write the resolved content to ours, drop the conflict
        // record (deletes sibling + .conflicts/<id>/), and refresh.
        await this.deps.writeResolved(record.vaultPath, finalText);
        await this.deps.conflictStore.resolve(record.id);
        if (this.deps.onConflictResolved) {
          this.deps.onConflictResolved(record);
        }
        if (this.selectedRecordId === record.id) {
          this.selectedRecordId = null;
        }
        this.refreshList();
        this.clearPane();
      },
    });
  }

  private clearPane(): void {
    if (this.currentDiff) {
      this.currentDiff.destroy();
      this.currentDiff = null;
    }
    if (this.paneEl) this.paneEl.empty();
  }
}

