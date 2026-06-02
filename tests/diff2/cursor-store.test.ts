// Stage 3b — cursor.json persist / read / clamp (DIFF-EDITOR.md §2.9).
// Node env (real fs over tmpdir); persist also run under MOCK_PLATFORM=mobile
// (atomic rewrite over an existing cursor.json — the Capacitor rename rule).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault, setMockPlatform } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import { clampCursor, persistCursor, readCursor } from "../../src/diff2/cursor-store";

const ID = "tracked-cursor";
const NOW = "2026-06-02T12:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function fixture() {
  const root = path.join(os.tmpdir(), `cursor-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

describe("clampCursor — §2.9 / §3.3", () => {
  it("in-range unchanged", () => {
    expect(clampCursor({ anchor: 5, head: 8 }, 20)).toEqual({ anchor: 5, head: 8 });
  });
  it("clamps past doc end (doc shrank during replay)", () => {
    expect(clampCursor({ anchor: 99, head: 50 }, 10)).toEqual({ anchor: 10, head: 10 });
  });
  it("clamps negatives to 0", () => {
    expect(clampCursor({ anchor: -3, head: -1 }, 10)).toEqual({ anchor: 0, head: 0 });
  });
});

describe("persistCursor / readCursor", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(async () => {
    setMockPlatform("desktop");
    fx = fixture();
    await fx.vault.adapter.writeBinary("base.md", enc("b\n"));
    await fx.vault.adapter.writeBinary("sib.md", enc("s\n"));
    await startSession(fx.vault, ID, "base.md", "sib.md", NOW); // writes initial cursor (0,0,0)
  });
  afterEach(() => {
    setMockPlatform("desktop");
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it("startSession's initial cursor reads back as (0,0,0)", async () => {
    const c = await readCursor(fx.vault, ID);
    expect(c).toMatchObject({ v: 1, anchor: 0, head: 0, scrollTop: 0, savedAt: NOW });
  });

  it("persist then read returns the new position; no .tmp left behind", async () => {
    await persistCursor(fx.vault, ID, { anchor: 1247, head: 1247, scrollTop: 8420 }, NOW);
    const c = await readCursor(fx.vault, ID);
    expect(c).toEqual({ v: 1, anchor: 1247, head: 1247, scrollTop: 8420, savedAt: NOW });
    expect(await fx.vault.adapter.exists(`${autosaveDir(ID)}/cursor.json.tmp`)).toBe(false);
  });

  it("repeated persist overwrites (atomic rewrite over existing)", async () => {
    await persistCursor(fx.vault, ID, { anchor: 10, head: 10 }, NOW);
    await persistCursor(fx.vault, ID, { anchor: 20, head: 25 }, NOW);
    const c = await readCursor(fx.vault, ID);
    expect(c).toMatchObject({ anchor: 20, head: 25, scrollTop: 0 });
  });

  it("scrollTop defaults to 0 when omitted", async () => {
    await persistCursor(fx.vault, ID, { anchor: 3, head: 3 }, NOW);
    expect((await readCursor(fx.vault, ID))?.scrollTop).toBe(0);
  });

  it("missing → null", async () => {
    await fx.vault.adapter.remove(`${autosaveDir(ID)}/cursor.json`);
    expect(await readCursor(fx.vault, ID)).toBeNull();
  });

  it("corrupt JSON → null (skip cursor apply, §3.5)", async () => {
    await fx.vault.adapter.write(`${autosaveDir(ID)}/cursor.json`, "{ not json");
    expect(await readCursor(fx.vault, ID)).toBeNull();
  });

  it("wrong shape (no numeric anchor/head) → null", async () => {
    await fx.vault.adapter.write(`${autosaveDir(ID)}/cursor.json`, JSON.stringify({ v: 1, savedAt: NOW }));
    expect(await readCursor(fx.vault, ID)).toBeNull();
  });

  it("under MOCK_PLATFORM=mobile: rewrite over existing cursor.json works", async () => {
    setMockPlatform("mobile");
    await persistCursor(fx.vault, ID, { anchor: 42, head: 42 }, NOW); // over the (0,0,0) startSession wrote
    expect((await readCursor(fx.vault, ID))?.anchor).toBe(42);
  });
});
