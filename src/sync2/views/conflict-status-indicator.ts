// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Pseudo-merge stage 10 — persistent status-bar indicator that
// surfaces the pending-conflict count. Spec
// (PSEUDO-MERGE-MODE.md §"4-точкове попередження користувачу" #1):
//
//   🔀 3 files — not visible on other devices
//
// Visible only when count > 0; hidden (zero-width) otherwise so the
// status bar doesn't carry dead space on a healthy device.

export class ConflictStatusIndicator {
  private readonly el: HTMLElement;
  private readonly onClick: (() => void) | undefined;

  constructor(parent: HTMLElement, onClick?: () => void) {
    this.el = parent.createSpan({ cls: "github-easy-sync-conflict-status" });
    this.el.style.cursor = "pointer";
    this.onClick = onClick;
    if (onClick) this.el.addEventListener("click", onClick);
    this.refresh(0);
  }

  // Update the displayed count. Single-source-of-truth callers
  // (main.ts) invoke this after each sync drain AND on every
  // ConflictWatcher.onResolution.
  refresh(count: number): void {
    if (count <= 0) {
      this.el.style.display = "none";
      this.el.setText("");
      this.el.removeAttribute("aria-label");
      return;
    }
    this.el.style.display = "";
    const word = count === 1 ? "file" : "files";
    const text = `🔀 ${count} ${word} — not visible on other devices`;
    this.el.setText(text);
    this.el.setAttribute("aria-label", text);
  }

  destroy(): void {
    if (this.onClick) this.el.removeEventListener("click", this.onClick);
    this.el.remove();
  }
}
