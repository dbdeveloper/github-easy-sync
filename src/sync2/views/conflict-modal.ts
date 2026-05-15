import { App, Modal, Setting } from "obsidian";

// Per-file conflict modal (Stage 6.5). Pops up once for each file
// that hits an unresolvable 3-way merge during a sync. The user
// picks one of:
//
//   - resolve-now      → open the Conflict View tab and merge in the
//                        diff editor; sync2 waits for the result.
//   - later            → ConflictStore captures (base, theirs) and
//                        writes the sibling file; ours stays as-is.
//   - merge-into-one   → markdown auto-merge via callouts (markdown
//                        files only; the option is hidden otherwise).
//   - defer-all        → bulk Later for THIS file plus every other
//                        conflict still in the current sync; the
//                        outer loop calls `decideAllRemaining()`
//                        after this and skips the modal for them.
//
// The "resolve-now" path is currently routed back through the modal
// as `later` (i.e. the conflict gets persisted and the user hops
// over to the Conflict View manually) until the actual diff-editor
// hand-off in step 4. The contract here is stable; only the wiring
// in main.ts changes.

export type ConflictChoice =
  | "resolve-now"
  | "later"
  | "merge-into-one"
  | "defer-all";

export interface ConflictPromptArgs {
  // Vault path of the file in conflict.
  path: string;
  // 1-based index of this file within the current sync's conflict
  // batch; total tells the user how many more to expect. Both equal
  // 1 for a single-file conflict.
  index: number;
  total: number;
  // Whether this file is markdown — gates the "merge-into-one"
  // button. Non-markdown text (`.json`, `.yml`, `.css`, …) hides it
  // because callout-style inlining would corrupt those formats.
  isMarkdown: boolean;
}

// Pure helper: pick which buttons to show given the file type and
// position in the batch. Used both by the live modal and by tests
// that don't render DOM.
export function availableChoices(args: ConflictPromptArgs): ConflictChoice[] {
  const out: ConflictChoice[] = ["resolve-now", "later"];
  if (args.isMarkdown) out.push("merge-into-one");
  // "Defer ALL remaining" only makes sense when there's more than
  // one conflict in the batch — otherwise it's identical to "later".
  if (args.total - args.index > 0) out.push("defer-all");
  return out;
}

// Modal prompt. Resolves with the user's choice; if the user
// dismisses the modal (Esc / click outside), the Promise resolves
// with `later` — same semantics as a deliberate "Later" click, so
// closing the modal never destroys data.
export class ConflictModal extends Modal {
  private resolved = false;
  private resolver!: (choice: ConflictChoice) => void;

  constructor(
    app: App,
    private readonly args: ConflictPromptArgs,
  ) {
    super(app);
  }

  prompt(): Promise<ConflictChoice> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, args } = this;
    contentEl.empty();

    // Header: file path + position.
    contentEl.createEl("h3", {
      text:
        args.total > 1
          ? `Sync conflict (${args.index} of ${args.total}): ${args.path}`
          : `Sync conflict: ${args.path}`,
    });
    contentEl.createEl("p", {
      text: "Local and remote versions have overlapping changes that couldn't be auto-merged.",
    });

    const choices = availableChoices(args);

    new Setting(contentEl)
      .setName("Resolve now")
      .setDesc("Open the diff editor and merge interactively.")
      .addButton((b) =>
        b
          .setButtonText("Resolve now")
          .setCta()
          .onClick(() => this.choose("resolve-now")),
      );

    new Setting(contentEl)
      .setName("Later")
      .setDesc(
        "Save the remote version next to the original; come back via the conflict view tab.",
      )
      .addButton((b) =>
        b.setButtonText("Later").onClick(() => this.choose("later")),
      );

    if (choices.includes("merge-into-one")) {
      new Setting(contentEl)
        .setName("Merge into one")
        .setDesc(
          "Append the remote version under the original as a markdown callout. Reconcile manually later.",
        )
        .addButton((b) =>
          b
            .setButtonText("Merge into one")
            .onClick(() => this.choose("merge-into-one")),
        );
    }

    if (choices.includes("defer-all")) {
      contentEl.createEl("hr");
      new Setting(contentEl)
        .setName("Defer ALL remaining")
        .setDesc(
          `Skip every conflict in this sync (${args.total - args.index} more files). All deferred conflicts appear in the conflict view.`,
        )
        .addButton((b) =>
          b
            .setButtonText("Defer ALL remaining")
            .setWarning()
            .onClick(() => this.choose("defer-all")),
        );
    }
  }

  onClose(): void {
    // Esc / click-outside — treat as "Later" for this file. Never
    // destroy data via dismissal.
    if (!this.resolved) this.choose("later");
    this.contentEl.empty();
  }

  private choose(choice: ConflictChoice): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolver(choice);
    this.close();
  }
}
