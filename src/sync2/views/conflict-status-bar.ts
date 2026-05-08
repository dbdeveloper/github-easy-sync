// Status-bar widget that shows pending conflict count (Etap 6.5).
// Hidden when there are no pending conflicts; visible as `🔀 N`
// otherwise. Click opens the Conflict View workspace leaf.
//
// Pure rendering — DOM mutation lives in the controller below.
// The state machine (count → label) is extracted to a function so
// tests can pin the formatting without a real status-bar element.

// Format the visible label for a given pending count. `null` means
// "hide the widget entirely" (no element on the status bar).
export function statusBarLabel(count: number): string | null {
  if (count <= 0) return null;
  // 🔀 = U+1F500 (TWISTED RIGHTWARDS ARROWS); reads as "two-way
  // exchange" which matches the conflict-resolution metaphor.
  return `🔀 ${count}`;
}

// Tooltip — gives the user a hint about what clicking does.
export function statusBarTooltip(count: number): string {
  if (count === 1) return "1 sync conflict pending — click to resolve";
  return `${count} sync conflicts pending — click to resolve`;
}

// Live controller. Wraps the HTMLElement returned by
// plugin.addStatusBarItem(). Construct once at plugin onload, then
// call refresh(count) whenever the conflict count changes (after
// every syncAll, after sibling delete listener fires, etc.).
//
// `onClick` is the only side-effect — a no-arg function that opens
// the Conflict View leaf. Plumbed from main.ts so this module stays
// independent of workspace API specifics.
export class ConflictStatusBar {
  private currentCount = 0;

  constructor(
    private readonly el: HTMLElement,
    onClick: () => void,
  ) {
    this.el.addClass("sync2-conflict-status");
    this.el.style.cursor = "pointer";
    this.el.addEventListener("click", onClick);
    // Start hidden — addStatusBarItem reserves space immediately, so
    // we toggle display via CSS rather than removing the node.
    this.el.style.display = "none";
  }

  refresh(count: number): void {
    if (count === this.currentCount) return;
    this.currentCount = count;
    const label = statusBarLabel(count);
    if (label === null) {
      this.el.style.display = "none";
      this.el.setText("");
      return;
    }
    this.el.style.display = "";
    this.el.setText(label);
    this.el.setAttribute("aria-label", statusBarTooltip(count));
    this.el.title = statusBarTooltip(count);
  }

  destroy(): void {
    // Idempotent — fine to call from plugin.onunload even if the
    // status bar item was never added.
    this.el.empty();
  }
}
