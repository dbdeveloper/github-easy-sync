// W3 — CursorScheduler throttle (DIFF-EDITOR.md §2.9). Fake timers, no DOM.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CursorScheduler, CURSOR_FLUSH_MS } from "../../src/diff2/cursor-timer";

// Injected timer fns backed by the (fake) globals vitest patches.
const timers = {
  set: (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as number,
  clear: (id: number) => clearTimeout(id),
};

describe("CursorScheduler — throttle (§2.9)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("CURSOR_FLUSH_MS pins the ratified cadences", () => {
    expect(CURSOR_FLUSH_MS).toEqual({ typing: 2500, nav: 6000 });
  });

  it("flushes once at the typing cadence (2500 ms)", () => {
    let n = 0;
    const s = new CursorScheduler(() => n++, timers);
    s.schedule("typing");
    vi.advanceTimersByTime(2499);
    expect(n).toBe(0);
    vi.advanceTimersByTime(1);
    expect(n).toBe(1);
  });

  it("nav cadence is 6000 ms", () => {
    let n = 0;
    const s = new CursorScheduler(() => n++, timers);
    s.schedule("nav");
    vi.advanceTimersByTime(5999);
    expect(n).toBe(0);
    vi.advanceTimersByTime(1);
    expect(n).toBe(1);
  });

  it("throttles: a burst within the window collapses to ONE flush (earliest window wins)", () => {
    let n = 0;
    const s = new CursorScheduler(() => n++, timers);
    s.schedule("typing"); // opens a 2500 window
    vi.advanceTimersByTime(1000);
    s.schedule("nav"); // ignored — a window is already pending
    s.schedule("typing"); // ignored
    vi.advanceTimersByTime(1500); // 2500 since the first schedule
    expect(n).toBe(1);
    // a fresh schedule after the flush opens a new window
    s.schedule("typing");
    vi.advanceTimersByTime(2500);
    expect(n).toBe(2);
  });

  it("stop() cancels a pending flush", () => {
    let n = 0;
    const s = new CursorScheduler(() => n++, timers);
    s.schedule("typing");
    vi.advanceTimersByTime(1000);
    s.stop();
    vi.advanceTimersByTime(10_000);
    expect(n).toBe(0);
  });

  it("stop() with nothing pending is a no-op; a later schedule still fires", () => {
    let n = 0;
    const s = new CursorScheduler(() => n++, timers);
    s.stop();
    s.schedule("nav");
    vi.advanceTimersByTime(6000);
    expect(n).toBe(1);
  });
});
