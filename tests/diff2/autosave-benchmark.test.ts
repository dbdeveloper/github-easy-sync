// Mobile autosave benchmark — the timing numbers are only meaningful ON the
// device, but the harness (percentile math + a clean run that produces a report
// and leaves no files) is unit-testable. Node env (real fs over tmpdir).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import {
  computeStats,
  percentile,
  runAutosaveBenchmark,
} from "../../src/diff2/autosave-benchmark";

describe("percentile / computeStats", () => {
  it("percentile endpoints + interpolation", () => {
    const s = [10, 20, 30, 40, 50];
    expect(percentile(s, 0)).toBe(10);
    expect(percentile(s, 100)).toBe(50);
    expect(percentile(s, 50)).toBe(30);
    expect(percentile(s, 95)).toBeCloseTo(48, 5); // 0.95*4=3.8 → 40 + (50-40)*0.8
  });
  it("handles empty + single", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 95)).toBe(7);
  });
  it("computeStats sorts + fills fields", () => {
    const st = computeStats([30, 10, 20]);
    expect(st.min).toBe(10);
    expect(st.max).toBe(30);
    expect(st.p50).toBe(20);
    expect(st.mean).toBeCloseTo(20, 5);
    expect(st.n).toBe(3);
  });
});

describe("runAutosaveBenchmark (smoke over mock-obsidian)", () => {
  let root: string;
  let vault: Vault;
  beforeEach(() => {
    root = path.join(os.tmpdir(), `bench-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(root, { recursive: true });
    vault = new MockVault(root) as unknown as Vault;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("runs all three ops, reports stats, and leaves NO files behind", async () => {
    const r = await runAutosaveBenchmark(vault, { iterations: 20 });
    expect(r.iterations).toBe(20);
    expect(r.lineBytes).toBeGreaterThan(0);
    expect(r.singleAppend.n).toBe(20);
    expect(r.batchedAppendPerLine.n).toBeGreaterThanOrEqual(20);
    expect(r.cursorRewrite.n).toBe(20);
    expect(r.report).toContain("history append (single)");
    expect(r.report).toContain("recommendation:");
    // Clean up: the benchmark dir must be gone.
    expect(await vault.adapter.exists(".diff2-bench")).toBe(false);
  });
});
