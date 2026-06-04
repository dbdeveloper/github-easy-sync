// Recovery dialog (DIFF-EDITOR.md §3.2 / §3.2.a).
//
// ONE modal, following the proven `prompt(): Promise<choice>` pattern
// (PreSyncConflictModal): the promise resolves on `onClose`, default choice is
// "cancel", explicit button clicks overwrite it before close. MAXIMALLY COMPACT
// (fit an average phone) yet informative — short labels, no scrolling.
//
//   §3.2   ResumeRecoveryModal — interrupted session: replay-resume vs fresh.
//          [Continue editing] / [Start over] / ×(cancel).
//   §3.2.a one vault side changed under the session → the SAME modal (it is just
//          crash recovery — no scary "files changed" dialog); a "*" + footnote
//          marks the changed file, and Continue carries the user's edit for the
//          UNCHANGED side onto the new version (mechanics in the view).

import { App, Modal } from "obsidian";

export type ResumeChoice = "continue" | "start-over" | "cancel";

export interface ResumeInfo {
  basePath: string;
  siblingPath: string;
  startedAtIso: string;
  editCount: number;
  // Optional "Last:" clock (last edit / cursor save). Omitted if absent.
  lastEditIso?: string;
  // Marks a side with "*" + a footnote when that vault file changed under the
  // session. §3.2.a one-side-changed recovery REUSES this modal (no separate
  // "files changed" dialog — it is just crash recovery). Both false on a plain
  // resume.
  baseChanged?: boolean;
  siblingChanged?: boolean;
  // Injected for deterministic relative-time rendering (caller: Date.now()).
  nowMs: number;
}

// "just now" / "12 minutes ago" / "2 hours ago" / "3 days ago". Pure + tested.
export function relativeTimeFromIso(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "some time ago";
  const min = Math.floor(Math.max(0, nowMs - then) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

// "HH:MM:SS" local-clock for the "Last:" line. "" on an unparseable input.
export function clockFromIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// §3.2 — vault unchanged since session start. Offer replay-resume or fresh.
export class ResumeRecoveryModal extends Modal {
  private choice: ResumeChoice = "cancel";

  constructor(
    app: App,
    private readonly info: ResumeInfo,
  ) {
    super(app);
  }

  prompt(): Promise<ResumeChoice> {
    return new Promise((resolve) => {
      this.onClose = () => resolve(this.choice);
      const c = this.contentEl;
      this.titleEl.setText("Resume previous edit session?");
      c.empty();

      c.createEl("p").setText("Unfinished edit session for:");
      const star = (changed?: boolean) => (changed ? "* " : "");
      const ul = c.createEl("ul");
      ul.createEl("li").setText(
        `${star(this.info.baseChanged)}base: ${this.info.basePath}`,
      );
      ul.createEl("li").setText(
        `${star(this.info.siblingChanged)}sibling: ${this.info.siblingPath}`,
      );
      const meta =
        `Started ${relativeTimeFromIso(this.info.startedAtIso, this.info.nowMs)}` +
        ` · ${this.info.editCount} edit${this.info.editCount === 1 ? "" : "s"} saved` +
        (this.info.lastEditIso
          ? ` · last ${clockFromIso(this.info.lastEditIso)}`
          : "");
      c.createEl("p").setText(meta);
      if (this.info.baseChanged || this.info.siblingChanged) {
        c.createEl("p", { cls: "diff2-recovery-footnote" }).setText(
          "* this file changed in the vault since the last editing session.",
        );
      }

      const row = c.createDiv({ cls: "modal-button-container" });
      const cont = row.createEl("button", {
        text: "Continue editing",
        cls: "mod-cta",
      });
      cont.addEventListener("click", () => {
        this.choice = "continue";
        this.close();
      });
      const over = row.createEl("button", { text: "Start over" });
      over.addEventListener("click", () => {
        this.choice = "start-over";
        this.close();
      });
      const cancel = row.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => {
        this.choice = "cancel";
        this.close();
      });

      this.open();
    });
  }
}
