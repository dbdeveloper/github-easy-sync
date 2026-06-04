// Stage 3a — history.jsonl block format + checksum + coalesce writer
// (DIFF-EDITOR.md §2.6–§2.8). Node env (real fs over tmpdir); the writer test
// composes Stage 2.0 startSession so the autosave dir exists.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import type { Segment } from "../../src/diff2/editor-model";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import {
  HistoryWriter,
  fnv1a32,
  parseHistoryBlock,
  serializeHistoryBlock,
  verifyHistoryBlock,
} from "../../src/diff2/history-log";

const STRUCT: Segment[] = [
  { role: "normal", group: -1, from: 0, to: 4 },
  { role: "ver1", group: 0, from: 4, to: 7 },
  { role: "ver2", group: 0, from: 7, to: 10 },
];
const CHANGE = [4, [3, "abc"]]; // shape of a ChangeSet.toJSON()

describe("fnv1a32 — published FNV-1a-32 vectors", () => {
  it('"" → offset basis 811c9dc5', () => expect(fnv1a32("")).toBe("811c9dc5"));
  it('"a"', () => expect(fnv1a32("a")).toBe("e40c292c"));
  it('"foobar"', () => expect(fnv1a32("foobar")).toBe("bf9cf968"));
  it("always 8 lowercase hex", () => {
    for (const s of ["", "x", "the quick brown fox", "café"]) {
      expect(fnv1a32(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe("history block serialize / parse / verify (§2.6)", () => {
  it("round-trips and verifies", () => {
    const line = serializeHistoryBlock(1, "2026-06-02T12:00:00.000Z", CHANGE, STRUCT);
    const block = parseHistoryBlock(line);
    expect(block).not.toBeNull();
    expect(block!.seq).toBe(1);
    expect(block!.change).toEqual(CHANGE);
    expect(block!.structure).toEqual(STRUCT);
    expect(verifyHistoryBlock(block!)).toBe(true);
  });

  it("tampered change → verify false (sum covers change)", () => {
    const block = parseHistoryBlock(serializeHistoryBlock(1, "t", CHANGE, STRUCT))!;
    block.change = [4, [3, "XYZ"]];
    expect(verifyHistoryBlock(block)).toBe(false);
  });

  it("tampered structure → verify false (sum covers structure too)", () => {
    const block = parseHistoryBlock(serializeHistoryBlock(1, "t", CHANGE, STRUCT))!;
    block.structure = [{ role: "normal", group: -1, from: 0, to: 99 }];
    expect(verifyHistoryBlock(block)).toBe(false);
  });

  it("blank / corrupt / wrong-shape lines → null", () => {
    expect(parseHistoryBlock("")).toBeNull();
    expect(parseHistoryBlock("   ")).toBeNull();
    expect(parseHistoryBlock("{not json")).toBeNull();
    expect(parseHistoryBlock(JSON.stringify({ seq: 1, at: "t", sum: "x" }))).toBeNull(); // no change/structure
  });
});

describe("HistoryWriter — serialized append per transaction (§2.7/§2.8)", () => {
  let fx: { root: string; vault: Vault };
  const ID = "tracked-hist";

  beforeEach(async () => {
    const root = path.join(os.tmpdir(), `hist-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(root, { recursive: true });
    const vault = new MockVault(root) as unknown as Vault;
    await vault.adapter.writeBinary("base.md", new TextEncoder().encode("b\n").buffer as ArrayBuffer);
    await vault.adapter.writeBinary("sib.md", new TextEncoder().encode("s\n").buffer as ArrayBuffer);
    await startSession(vault, ID, "base.md", "sib.md", "2026-06-02T12:00:00.000Z");
    fx = { root, vault };
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const histPath = () => `${autosaveDir(ID)}/history.jsonl`;
  const readLines = async () =>
    (await fx.vault.adapter.read(histPath())).split("\n").filter(Boolean);

  it("record enqueues synchronously + schedules a serialized append; drain settles all", async () => {
    const w = new HistoryWriter(fx.vault, ID);
    w.record(CHANGE, STRUCT, "t1");
    w.record([2, [1, "Q"]], STRUCT, "t2");
    expect(w.pendingCount()).toBe(2); // both queued before any append runs
    await w.drain();
    expect(w.pendingCount()).toBe(0);
    const blocks = (await readLines()).map((l) => parseHistoryBlock(l));
    expect(blocks.map((b) => b!.seq)).toEqual([1, 2]);
    for (const b of blocks) expect(verifyHistoryBlock(b!)).toBe(true); // byte-identical roundtrip
  });

  it("burst of synchronous records → all blocks, in order, contiguous seq (serialized flush)", async () => {
    const w = new HistoryWriter(fx.vault, ID);
    const N = 25;
    for (let i = 0; i < N; i++) w.record(CHANGE, STRUCT, `t${i}`);
    await w.drain();
    const seqs = (await readLines()).map((l) => parseHistoryBlock(l)!.seq);
    // No interleaving / clobber: exactly 1..N, in order.
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it("startSeq continues a resumed history.jsonl (resume-Continue keeps the dir)", async () => {
    const w = new HistoryWriter(fx.vault, ID, 7);
    w.record(CHANGE, STRUCT, "t1");
    w.record(CHANGE, STRUCT, "t2");
    await w.drain();
    const seqs = (await readLines()).map((l) => parseHistoryBlock(l)!.seq);
    expect(seqs).toEqual([8, 9]);
    expect(w.currentSeq()).toBe(9);
  });

  it("drain on an empty writer is a no-op", async () => {
    const w = new HistoryWriter(fx.vault, ID);
    await w.drain();
    expect((await fx.vault.adapter.read(histPath())).length).toBe(0);
  });
});
