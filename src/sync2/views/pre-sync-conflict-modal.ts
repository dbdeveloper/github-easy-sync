// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { App, Modal } from "obsidian";

// Pre-sync confirmation modal — one of three visibility surfaces
// for pending conflicts. Fires before EVERY manual sync click while
// ConflictStore has at least one active record:
//
//   "N file(s) still in conflict. [resolve] [sync anyway]"
//
// We add a Cancel button for the standard escape hatch (user
// changed their mind mid-click). Returns the user's chosen action:
//
//   - "resolve"     — user wants to act on the conflicts now;
//                     caller opens the first sibling in the editor.
//   - "sync-anyway" — user accepts the warning; sync proceeds.
//   - "cancel"      — bail; sync skipped.
//
// Modal is fired by manual sync() / syncCurrentFile() only.
// Background drains (interval tick, watchdog, onload startup) skip
// the modal — they're not user-driven and a blocking dialog would
// surprise the user.

export type PreSyncDecision = "resolve" | "sync-anyway" | "cancel";

export class PreSyncConflictModal extends Modal {
  private decision: PreSyncDecision = "cancel";

  constructor(
    app: App,
    private readonly paths: string[],
  ) {
    super(app);
  }

  // Render the modal and resolve with the user's choice when it
  // closes. Closing via Escape / clicking outside / the X button is
  // treated as "cancel" (decision is initialised to "cancel" and
  // only the explicit button clicks overwrite it).
  prompt(): Promise<PreSyncDecision> {
    return new Promise((resolve) => {
      this.onClose = () => resolve(this.decision);

      const n = this.paths.length;
      const word = n === 1 ? "file" : "files";
      this.titleEl.setText(`${n} ${word} still in conflict`);
      this.contentEl.empty();

      this.contentEl.createEl("p").setText(
        `Files in conflict are not visible on other devices until you resolve them.`,
      );
      // Cap the visible list at the first 20 paths so a sweep of
      // hundreds (rare but possible) doesn't make the modal
      // unscrollable.
      const list = this.contentEl.createEl("ul");
      const visible = this.paths.slice(0, 20);
      for (const p of visible) {
        list.createEl("li").setText(p);
      }
      if (this.paths.length > visible.length) {
        this.contentEl
          .createEl("p")
          .setText(`… and ${this.paths.length - visible.length} more.`);
      }

      const btnRow = this.contentEl.createDiv({
        cls: "modal-button-container",
      });
      const resolveBtn = btnRow.createEl("button", { text: "Resolve" });
      resolveBtn.addEventListener("click", () => {
        this.decision = "resolve";
        this.close();
      });
      const syncAnywayBtn = btnRow.createEl("button", {
        text: "Sync anyway",
      });
      syncAnywayBtn.addEventListener("click", () => {
        this.decision = "sync-anyway";
        this.close();
      });
      const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
      cancelBtn.addEventListener("click", () => {
        this.decision = "cancel";
        this.close();
      });

      this.open();
    });
  }
}
