// W4b — Recovery dialogs (DIFF-EDITOR.md §3.2 / §3.2.a).
//
// Two modals, both following the proven `prompt(): Promise<choice>` pattern
// (PreSyncConflictModal): the promise resolves on `onClose`, default choice is
// "cancel", explicit button clicks overwrite it before close. Designed to be
// MAXIMALLY COMPACT (fit an average phone) yet informative enough to understand
// the situation — short labels, the changed-side marked with `*`, no scrolling
// on typical content.
//
//   §3.2   ResumeRecoveryModal       — vault unchanged since session start:
//          [Continue editing] / [Start over] / ×(cancel)
//   §3.2.a SnapshotMismatchModal     — vault changed under the session:
//          ● Restore / ○ Discard  +  [Proceed] / [Cancel]

import { App, Modal } from "obsidian";

export type ResumeChoice = "continue" | "start-over" | "cancel";
export type MismatchChoice = "restore" | "discard" | "cancel";

export interface ResumeInfo {
  basePath: string;
  siblingPath: string;
  startedAtIso: string;
  editCount: number;
  // Optional "Last:" clock (last edit / cursor save). Omitted if absent.
  lastEditIso?: string;
  // Injected for deterministic relative-time rendering (caller: Date.now()).
  nowMs: number;
}

export interface MismatchInfo {
  basePath: string;
  siblingPath: string;
  startedAtIso: string;
  editCount: number;
  baseChanged: boolean;
  siblingChanged: boolean;
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
      const ul = c.createEl("ul");
      ul.createEl("li").setText(`base: ${this.info.basePath}`);
      ul.createEl("li").setText(`sibling: ${this.info.siblingPath}`);
      const meta =
        `Started ${relativeTimeFromIso(this.info.startedAtIso, this.info.nowMs)}` +
        ` · ${this.info.editCount} edit${this.info.editCount === 1 ? "" : "s"} saved` +
        (this.info.lastEditIso
          ? ` · last ${clockFromIso(this.info.lastEditIso)}`
          : "");
      c.createEl("p").setText(meta);

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

      this.open();
    });
  }
}

// §3.2.a — one or both vault files changed since the session started. Restore
// the old state (review/copy, save-to-alt on exit) or discard for a fresh one.
export class SnapshotMismatchModal extends Modal {
  private choice: MismatchChoice = "cancel";
  // Restore is the default (recommended) radio selection.
  private selected: "restore" | "discard" = "restore";

  constructor(
    app: App,
    private readonly info: MismatchInfo,
  ) {
    super(app);
  }

  prompt(): Promise<MismatchChoice> {
    return new Promise((resolve) => {
      this.onClose = () => resolve(this.choice);
      const c = this.contentEl;
      this.titleEl.setText("Conflict files changed since you started");
      c.empty();

      const ago = relativeTimeFromIso(this.info.startedAtIso, this.info.nowMs);
      c.createEl("p").setText(
        `You edited these based on their state from ${ago}` +
          ` (${this.info.editCount} edit${this.info.editCount === 1 ? "" : "s"} saved):`,
      );
      const ul = c.createEl("ul");
      const star = (changed: boolean) => (changed ? "* " : "");
      ul.createEl("li").setText(`${star(this.info.baseChanged)}base: ${this.info.basePath}`);
      ul.createEl("li").setText(
        `${star(this.info.siblingChanged)}sibling: ${this.info.siblingPath}`,
      );
      c.createEl("p", { cls: "diff2-recovery-footnote" }).setText(
        "* changed in the vault since you last edited",
      );

      // Two radios — Restore (default) / Discard. Proceed acts on the pick.
      const group = "diff2-mismatch-choice";
      const mkRadio = (
        value: "restore" | "discard",
        label: string,
        desc: string,
      ) => {
        const wrap = c.createDiv({ cls: "diff2-recovery-option" });
        const input = wrap.createEl("input", { type: "radio" });
        input.name = group;
        input.value = value;
        if (value === this.selected) input.checked = true;
        input.addEventListener("change", () => {
          if (input.checked) this.selected = value;
        });
        wrap.createEl("span", { text: ` ${label}` });
        wrap.createEl("div", { cls: "diff2-recovery-desc", text: desc });
      };
      mkRadio(
        "restore",
        "Restore previous session",
        "Reopen your work to review/copy; [← back] proposes alt save paths.",
      );
      mkRadio(
        "discard",
        "Discard, start fresh",
        "Wipe the old session; resolve the conflict on the current files.",
      );
      c.createEl("p", { cls: "diff2-recovery-footnote" }).setText(
        "Cancel keeps the session as-is — resolve it on the filesystem if you prefer.",
      );

      const row = c.createDiv({ cls: "modal-button-container" });
      const proceed = row.createEl("button", {
        text: "Proceed",
        cls: "mod-cta",
      });
      proceed.addEventListener("click", () => {
        this.choice = this.selected; // "restore" | "discard"
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
