// W3 — cursor 2-slot ping-pong: persist / read / clamp (DIFF-EDITOR.md §2.9).
// Node env (real fs over tmpdir); a mobile smoke run confirms the plain-write
// ping-pong needs no Capacitor rename handling.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault, setMockPlatform } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import {
  autosaveDir,
  cursorSlotPath,
  startSession,
} from "../../src/diff2/autosave-store";
import {
  clampCursor,
  persistCursor,
  readCursor,
} from "../../src/diff2/cursor-store";

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

describe("persistCursor / readCursor — 2-slot ping-pong (§2.9)", () => {
  let fx: ReturnType<typeof fixture>;

  // Raw seq of one slot (-1 if absent/corrupt) and its anchor.
  const seqOf = async (slot: "a" | "b"): Promise<number> => {
    const p = cursorSlotPath(ID, slot);
    if (!(await fx.vault.adapter.exists(p))) return -1;
    try {
      return JSON.parse(await fx.vault.adapter.read(p)).seq ?? -1;
    } catch {
      return -1;
    }
  };
  const anchorOf = async (slot: "a" | "b"): Promise<number> =>
    JSON.parse(await fx.vault.adapter.read(cursorSlotPath(ID, slot))).anchor;
  const writeSlot = (slot: "a" | "b", body: string) =>
    fx.vault.adapter.write(cursorSlotPath(ID, slot), body);

  beforeEach(async () => {
    setMockPlatform("desktop");
    fx = fixture();
    await fx.vault.adapter.writeBinary("base.md", enc("b\n"));
    await fx.vault.adapter.writeBinary("sib.md", enc("s\n"));
    await startSession(fx.vault, ID, "base.md", "sib.md", NOW); // seeds cursor-a seq 0
  });
  afterEach(() => {
    setMockPlatform("desktop");
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it("seq-0 seed reads back, and beats the absent slot", async () => {
    expect(await seqOf("a")).toBe(0);
    expect(await seqOf("b")).toBe(-1);
    expect(await readCursor(fx.vault, ID)).toMatchObject({
      v: 1,
      seq: 0,
      anchor: 0,
      head: 0,
      scrollTop: 0,
      savedAt: NOW,
    });
  });

  // The load-bearing crash-safety invariant: each write targets the LOWER-seq
  // (stale) slot; the current max-seq slot (the recovery fallback) is NEVER
  // overwritten. A regression here silently kills crash-safety.
  it("always writes the LOWER-seq slot — the max-seq slot is never touched", async () => {
    // seed: a=0, b absent. persist → writes b (the stale/absent one); a untouched.
    await persistCursor(fx.vault, ID, { anchor: 1, head: 1 }, NOW);
    expect(await seqOf("b")).toBe(1);
    expect(await seqOf("a")).toBe(0); // pre-write max — untouched
    expect(await anchorOf("a")).toBe(0);

    // persist → now a(0) is the stale one → writes a seq2; b untouched.
    await persistCursor(fx.vault, ID, { anchor: 2, head: 2 }, NOW);
    expect(await seqOf("a")).toBe(2);
    expect(await seqOf("b")).toBe(1); // untouched
    expect(await anchorOf("b")).toBe(1);

    // persist → b is stale → writes b seq3.
    await persistCursor(fx.vault, ID, { anchor: 3, head: 3 }, NOW);
    expect(await seqOf("b")).toBe(3);
    expect(await seqOf("a")).toBe(2);

    // readCursor always returns the max-seq slot.
    expect(await readCursor(fx.vault, ID)).toMatchObject({ seq: 3, anchor: 3 });
  });

  it("persist then read returns the new position (full shape)", async () => {
    await persistCursor(fx.vault, ID, { anchor: 1247, head: 1247, scrollTop: 8420 }, NOW);
    expect(await readCursor(fx.vault, ID)).toEqual({
      v: 1,
      seq: 1,
      anchor: 1247,
      head: 1247,
      scrollTop: 8420,
      savedAt: NOW,
    });
  });

  it("a torn (corrupt) NEWER slot falls back to the older intact one", async () => {
    // a=0 (seed intact). simulate a crash mid-write of the newer slot b.
    await writeSlot("b", "{ torn write");
    expect(await readCursor(fx.vault, ID)).toMatchObject({ seq: 0, anchor: 0 });
  });

  it("reopen-continuity: stateless persist reads disk and continues the seq", async () => {
    await persistCursor(fx.vault, ID, { anchor: 5, head: 5 }, NOW); // b seq1
    await persistCursor(fx.vault, ID, { anchor: 6, head: 6 }, NOW); // a seq2
    // simulate a reopen: a fresh stateless call derives next seq from disk.
    await persistCursor(fx.vault, ID, { anchor: 7, head: 7 }, NOW); // b seq3
    expect(await readCursor(fx.vault, ID)).toMatchObject({ seq: 3, anchor: 7 });
  });

  it("scrollTop defaults to 0 when omitted", async () => {
    await persistCursor(fx.vault, ID, { anchor: 3, head: 3 }, NOW);
    expect((await readCursor(fx.vault, ID))?.scrollTop).toBe(0);
  });

  it("both slots missing → null", async () => {
    await fx.vault.adapter.remove(cursorSlotPath(ID, "a")); // b never existed
    expect(await readCursor(fx.vault, ID)).toBeNull();
  });

  it("both slots corrupt → null (skip cursor apply, §3.5)", async () => {
    await writeSlot("a", "{ not json");
    await writeSlot("b", "also { broken");
    expect(await readCursor(fx.vault, ID)).toBeNull();
  });

  it("wrong shape (no numeric seq) → slot ignored", async () => {
    // overwrite the only slot with a seq-less blob; b absent → both invalid.
    await writeSlot("a", JSON.stringify({ v: 1, anchor: 1, head: 1, savedAt: NOW }));
    expect(await readCursor(fx.vault, ID)).toBeNull();
  });

  it("under MOCK_PLATFORM=mobile: plain ping-pong write over an existing slot works", async () => {
    setMockPlatform("mobile");
    await persistCursor(fx.vault, ID, { anchor: 42, head: 42 }, NOW); // b
    await persistCursor(fx.vault, ID, { anchor: 43, head: 43 }, NOW); // a (over the seed)
    expect((await readCursor(fx.vault, ID))?.anchor).toBe(43);
  });
});
