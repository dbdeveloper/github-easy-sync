import { App, Modal, Setting } from "obsidian";

// Tiny prompt for Action 3 (sync current file with custom message).
// Pre-fills with a templated default; Enter pushes; Esc cancels.
export class CommitMessageModal extends Modal {
  private result: string | null = null;
  private resolveFn?: (msg: string | null) => void;

  constructor(
    app: App,
    private defaultMessage: string,
    // Single-file syncs pass the path so the modal title can show
    // "Commit message for foo.md". Whole-vault custom-message syncs
    // pass null and get a generic title.
    private filePath: string | null,
  ) {
    super(app);
  }

  prompt(): Promise<string | null> {
    return new Promise((resolve) => {
      this.resolveFn = resolve;
      this.open();
    });
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(
      this.filePath !== null
        ? `Commit message for ${this.filePath}`
        : "Commit message",
    );

    const input: { el: HTMLInputElement | null } = { el: null };
    new Setting(contentEl).setName("Message").addText((t) => {
      input.el = t.inputEl;
      t.setValue(this.defaultMessage);
      t.inputEl.style.width = "100%";
    });

    new Setting(contentEl)
      .addButton((b) => {
        b.setButtonText("Push")
          .setCta()
          .onClick(() => {
            this.result = input.el?.value ?? this.defaultMessage;
            this.close();
          });
      })
      .addButton((b) => {
        b.setButtonText("Cancel").onClick(() => {
          this.result = null;
          this.close();
        });
      });

    const el = input.el as HTMLInputElement | null;
    if (el) {
      el.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          this.result = el.value;
          this.close();
        } else if (ev.key === "Escape") {
          this.result = null;
          this.close();
        }
      });
      el.focus();
      el.select();
    }
  }

  onClose() {
    this.contentEl.empty();
    this.resolveFn?.(this.result);
  }
}
