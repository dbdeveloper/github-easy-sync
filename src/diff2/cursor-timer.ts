// W3 — cursor-flush throttle scheduler (DIFF-EDITOR.md §2.9).
//
// The DECISION of WHEN to persist the cursor is timer-driven (the persistence
// itself is cursor-store.ts). A THROTTLE, not a debounce: the first activity in
// an idle window schedules a flush at `delay`; further activity before it fires
// does NOT reschedule. This guarantees a flush within `delay` of activity even
// under continuous typing (a debounce would keep resetting and never fire).
//
// Two cadences (§2.9, ratified from the Android benchmark — cursor rewrite p95
// ≈ 28ms): typing 2500 ms, navigation 6000 ms. We deliberately do NOT shorten a
// pending nav-window when a typing event arrives mid-window — worst case is a
// cursor ≤6s stale on crash, and the content itself is safe in history.jsonl
// (W2). Gold-plating that interaction buys nothing for a best-effort signal.

export const CURSOR_FLUSH_MS = { typing: 2500, nav: 6000 } as const;
export type CursorActivity = keyof typeof CURSOR_FLUSH_MS;

export interface TimerFns {
  set: (cb: () => void, ms: number) => number;
  clear: (id: number) => void;
}

const defaultTimers: TimerFns = {
  set: (cb, ms) => window.setTimeout(cb, ms),
  clear: (id) => window.clearTimeout(id),
};

export class CursorScheduler {
  private pending: number | null = null;

  // `flush` is the side-effecting persist (fire-and-forget; it swallows its own
  // errors). `timers` is injectable for tests (fake timers).
  constructor(
    private readonly flush: () => void,
    private readonly timers: TimerFns = defaultTimers,
  ) {}

  // Schedule a flush `CURSOR_FLUSH_MS[activity]` from now, unless one is already
  // pending (throttle — the earlier window wins).
  schedule(activity: CursorActivity): void {
    if (this.pending !== null) return;
    this.pending = this.timers.set(() => {
      this.pending = null;
      this.flush();
    }, CURSOR_FLUSH_MS[activity]);
  }

  // Cancel any pending flush. MUST be called before the commit path mutates /
  // removes the autosave dir (a fired timer would persistCursor into a dir being
  // staged or removed → torn write / phantom dir).
  stop(): void {
    if (this.pending !== null) {
      this.timers.clear(this.pending);
      this.pending = null;
    }
  }
}
