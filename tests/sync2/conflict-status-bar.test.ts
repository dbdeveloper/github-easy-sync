import { describe, it, expect } from "vitest";
import {
  statusBarLabel,
  statusBarTooltip,
} from "../../src/sync2/views/conflict-status-bar";

describe("statusBarLabel", () => {
  it("returns null for zero (widget hides itself)", () => {
    expect(statusBarLabel(0)).toBeNull();
    expect(statusBarLabel(-1)).toBeNull();
  });

  it("formats `🔀 N` for positive counts", () => {
    expect(statusBarLabel(1)).toBe("🔀 1");
    expect(statusBarLabel(5)).toBe("🔀 5");
    expect(statusBarLabel(42)).toBe("🔀 42");
  });
});

describe("statusBarTooltip", () => {
  it("singular phrasing for exactly 1", () => {
    expect(statusBarTooltip(1)).toBe(
      "1 sync conflict pending — click to resolve",
    );
  });

  it("plural phrasing for >1", () => {
    expect(statusBarTooltip(5)).toBe(
      "5 sync conflicts pending — click to resolve",
    );
  });
});
