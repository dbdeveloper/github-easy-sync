// Test-infrastructure verification for MOCK_PLATFORM mode in
// mock-obsidian.ts.
//
// Why this exists: 2026-05-21 production incident — ConflictStore.create
// worked on desktop (POSIX fs.rename overwrites) but threw "Destination
// file already exists!" on mobile (Capacitor's Filesystem.rename rejects
// existing dests). Mock-obsidian uses Node fs which inherits POSIX
// semantics, so the divergence was invisible at unit-test time.
//
// MOCK_PLATFORM lets tests simulate Capacitor's stricter rename so
// production code's mobile-safe pattern (explicit remove + rename) is
// covered by unit tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault, setMockPlatform, getMockPlatform } from "../mock-obsidian";

describe("MOCK_PLATFORM", () => {
  let tmp: string;
  let vault: Vault;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "mock-platform-"));
    vault = new Vault(tmp);
    setMockPlatform("desktop"); // default each test
  });

  afterEach(() => {
    setMockPlatform("desktop"); // leave clean for next file
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults to desktop", () => {
    expect(getMockPlatform()).toBe("desktop");
  });

  it("desktop: rename overwrites existing destination (POSIX semantics)", async () => {
    await vault.adapter.write("a.txt", "from-a");
    await vault.adapter.write("b.txt", "from-b");

    // Should NOT throw — POSIX rename overwrites
    await vault.adapter.rename("a.txt", "b.txt");

    expect(await vault.adapter.exists("a.txt")).toBe(false);
    expect(await vault.adapter.exists("b.txt")).toBe(true);
    expect(await vault.adapter.read("b.txt")).toBe("from-a");
  });

  it("mobile: rename throws when destination exists (Capacitor semantics)", async () => {
    await vault.adapter.write("a.txt", "from-a");
    await vault.adapter.write("b.txt", "from-b");
    setMockPlatform("mobile");

    await expect(vault.adapter.rename("a.txt", "b.txt")).rejects.toThrow(
      "Destination file already exists",
    );

    // Both files still on disk untouched
    expect(await vault.adapter.read("a.txt")).toBe("from-a");
    expect(await vault.adapter.read("b.txt")).toBe("from-b");
  });

  it("mobile: rename succeeds when destination does NOT exist", async () => {
    await vault.adapter.write("a.txt", "from-a");
    setMockPlatform("mobile");

    // Destination doesn't exist → mobile path is identical to desktop
    await vault.adapter.rename("a.txt", "b.txt");

    expect(await vault.adapter.exists("a.txt")).toBe(false);
    expect(await vault.adapter.exists("b.txt")).toBe(true);
    expect(await vault.adapter.read("b.txt")).toBe("from-a");
  });

  it("mobile: explicit remove-before-rename is the portable pattern", async () => {
    await vault.adapter.write("a.txt", "from-a");
    await vault.adapter.write("b.txt", "from-b");
    setMockPlatform("mobile");

    // The portable pattern: explicitly remove destination first
    if (await vault.adapter.exists("b.txt")) {
      await vault.adapter.remove("b.txt");
    }
    await vault.adapter.rename("a.txt", "b.txt");

    expect(await vault.adapter.exists("a.txt")).toBe(false);
    expect(await vault.adapter.exists("b.txt")).toBe(true);
    expect(await vault.adapter.read("b.txt")).toBe("from-a");
  });

  // Pattern that Phase 3 tests should use for any rename-touching code.
  describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
    "describe.each pattern (under $platform)",
    ({ platform }) => {
      beforeEach(() => setMockPlatform(platform));

      it("a fresh rename into empty destination always works", async () => {
        await vault.adapter.write("src.txt", "x");
        await vault.adapter.rename("src.txt", "dst.txt");
        expect(await vault.adapter.read("dst.txt")).toBe("x");
      });
    },
  );
});
