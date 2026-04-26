import { App, Modal } from "obsidian";
import { AdoptionAnalysis, LocalState, RemoteState } from "../sync-state";

export type InitDecisionChoice =
  | "overwrite-remote"
  | "overwrite-local"
  | "cancel";

/**
 * Shown only when initial sync hits a real content conflict — i.e. the
 * same path exists on both sides with different content. Silent adoption
 * has already been ruled out by shouldAutoAdopt() returning false.
 *
 * Three buttons: keep local (push local up entirely, replacing remote),
 * keep remote (pull remote down entirely, replacing local), cancel. The
 * default if the user closes the modal without picking is "cancel".
 *
 * The body shows the per-category breakdown (identical / conflicting /
 * one-side-only) so the user understands the scale and risk before
 * committing to overwriting one side.
 */
export class InitDecisionModal extends Modal {
  private result: InitDecisionChoice = "cancel";
  private resolveFn?: (choice: InitDecisionChoice) => void;

  constructor(
    app: App,
    private localState: LocalState,
    private remoteState: RemoteState,
    private analysis: AdoptionAnalysis,
  ) {
    super(app);
  }

  /**
   * Open the modal and resolve once the user picks (or closes it).
   */
  prompt(): Promise<InitDecisionChoice> {
    return new Promise((resolve) => {
      this.resolveFn = resolve;
      this.open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Initial sync conflict" });

    contentEl.createEl("p", {
      text:
        "Both your local vault and the remote repository contain files, " +
        "and some of them have diverging content. There's no shared sync " +
        "history to merge against. Pick which side is the source of truth — " +
        "the other will be entirely replaced.",
    });

    this.renderBreakdown(contentEl);
    this.renderConflictSamples(contentEl);

    const btnContainer = contentEl.createEl("div", {
      cls: "modal-button-container",
    });

    const btnUseLocal = btnContainer.createEl("button", {
      text: "Keep local (overwrite remote)",
      cls: "mod-warning",
    });
    btnUseLocal.addEventListener("click", () => {
      this.result = "overwrite-remote";
      this.close();
    });

    const btnUseRemote = btnContainer.createEl("button", {
      text: "Keep remote (overwrite local)",
      cls: "mod-warning",
    });
    btnUseRemote.addEventListener("click", () => {
      this.result = "overwrite-local";
      this.close();
    });

    const btnCancel = btnContainer.createEl("button", {
      text: "Cancel sync",
    });
    btnCancel.addEventListener("click", () => {
      this.result = "cancel";
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
    this.resolveFn?.(this.result);
  }

  private renderBreakdown(parent: HTMLElement) {
    const summary = parent.createEl("div");
    summary.createEl("h3", { text: "Comparison" });
    const ul = summary.createEl("ul");
    ul.createEl("li", {
      text: `${this.analysis.identical.length} file(s) identical (same path, same content)`,
    });
    ul.createEl("li", {
      text: `${this.analysis.conflicting.length} file(s) differ`,
    });
    ul.createEl("li", {
      text: `${this.analysis.localOnly.length} file(s) only on local`,
    });
    ul.createEl("li", {
      text: `${this.analysis.remoteOnly.length} file(s) only on remote`,
    });
  }

  private renderConflictSamples(parent: HTMLElement) {
    if (this.analysis.conflicting.length === 0) return;
    const container = parent.createEl("div");
    container.createEl("h3", { text: "Conflicting paths" });
    const sample = this.analysis.conflicting.slice(0, 10);
    const ul = container.createEl("ul");
    for (const f of sample) {
      ul.createEl("li", { text: f });
    }
    if (this.analysis.conflicting.length > sample.length) {
      container.createEl("p", {
        text: `…and ${this.analysis.conflicting.length - sample.length} more`,
      });
    }
  }
}
