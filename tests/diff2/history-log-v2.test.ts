// V2 persistence — pure block core + thin writer (DIFF-EDITOR.md §0.5.2/§0.5.5).
// The pure parts (build/serialize/parse/verify/accrueStats/shouldCompact) need no
// vault and no CM6 view — StateEffects are constructed directly. The writer test
// composes Stage 2.0 startSession so the autosave dir exists (real fs / tmpdir).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import { resolveCaret, setStructure, toRangeSet } from "../../src/diff2/diff-structure";
import type { VerRange } from "../../src/diff2/diff-model";
import {
  HistoryWriterV2,
  accrueStats,
  buildCommandBlock,
  buildEditBlock,
  emptyStats,
  fnv1a32,
  parseBlock,
  serializeBlock,
  shouldCompact,
  verifyBlock,
} from "../../src/diff2/history-log-v2";

const CHANGE = [4, [3, "abc"]]; // shape of ChangeSet.toJSON()
const STRUCT: VerRange[] = [
  { from: 0, to: 4, ver: 1, group: 0 },
  { from: 4, to: 8, ver: 2, group: 0 },
];

describe("fnv1a32 — published FNV-1a-32 vectors (pinned)", () => {
  it('"" → offset basis 811c9dc5', () => expect(fnv1a32("")).toBe("811c9dc5"));
  it('"a"', () => expect(fnv1a32("a")).toBe("e40c292c"));
  it('"foobar"', () => expect(fnv1a32("foobar")).toBe("bf9cf968"));
});

describe("buildEditBlock — typing vs resolution (§0.5.2)", () => {
  it("typing: change only, newGroup from delta, no structure/caret", () => {
    const b = buildEditBlock(1, "t", CHANGE, [], 1);
    expect(b.kind).toBe("edit");
    expect(b.change).toEqual(CHANGE);
    expect(b.newGroup).toBe(true);
    expect(b.structure).toBeUndefined();
    expect(b.caret).toBeUndefined();
    expect(verifyBlock(b)).toBe(true);
  });

  it("undoDepthDelta 0 ⇒ coalesced (newGroup false)", () => {
    expect(buildEditBlock(2, "t", CHANGE, [], 0).newGroup).toBe(false);
  });

  it("resolution: pulls structure + caret from effects", () => {
    const effects = [setStructure.of(toRangeSet(STRUCT)), resolveCaret.of({ before: 5, after: 9 })];
    const b = buildEditBlock(3, "t", CHANGE, effects, 1);
    expect(b.structure).toEqual(STRUCT);
    expect(b.caret).toEqual({ before: 5, after: 9 });
    expect(verifyBlock(b)).toBe(true);
  });
});

describe("buildCommandBlock — undo / redo carry zero text", () => {
  it("undo and redo are distinct (sum covers kind → no undo↔redo flip)", () => {
    const u = buildCommandBlock("undo", 1, "t");
    const r = buildCommandBlock("redo", 1, "t");
    expect(u.kind).toBe("undo");
    expect(r.kind).toBe("redo");
    expect(verifyBlock(u)).toBe(true);
    expect(verifyBlock(r)).toBe(true);
    expect(u.sum).not.toBe(r.sum);
  });
});

describe("serialize / parse / verify round-trip (§0.5.2)", () => {
  it("edit (resolution) round-trips and verifies", () => {
    const b = buildEditBlock(1, "2026-06-13T00:00:00.000Z", CHANGE, [setStructure.of(toRangeSet(STRUCT)), resolveCaret.of({ before: 5, after: 9 })], 1);
    const p = parseBlock(serializeBlock(b));
    expect(p).toEqual(b);
    expect(verifyBlock(p!)).toBe(true);
  });

  it("command round-trips", () => {
    const b = buildCommandBlock("undo", 7, "t");
    expect(parseBlock(serializeBlock(b))).toEqual(b);
  });

  it("blank / corrupt / wrong-shape / unknown-kind → null", () => {
    expect(parseBlock("")).toBeNull();
    expect(parseBlock("   ")).toBeNull();
    expect(parseBlock("{not json")).toBeNull();
    expect(parseBlock(JSON.stringify({ kind: "edit", seq: 1, at: "t", sum: "x" }))).toBeNull(); // no change/newGroup
    expect(parseBlock(JSON.stringify({ kind: "wat", seq: 1, at: "t", sum: "x" }))).toBeNull();
    expect(parseBlock(JSON.stringify({ kind: "undo", at: "t", sum: "x" }))).toBeNull(); // no seq
  });
});

// ADVISOR #2 — the checksum must cover EVERY replay-driving field; a §1-style
// {change,structure}-only sum would silently break recovery on a corrupted
// newGroup / caret / kind.
describe("verifyBlock — sum covers every replay-driving field", () => {
  const edit = () =>
    parseBlock(serializeBlock(buildEditBlock(1, "t", CHANGE, [setStructure.of(toRangeSet(STRUCT)), resolveCaret.of({ before: 5, after: 9 })], 1)))! as ReturnType<typeof buildEditBlock>;

  it("tampered change → false", () => {
    const b = edit();
    b.change = [4, [3, "XYZ"]];
    expect(verifyBlock(b)).toBe(false);
  });
  it("tampered newGroup → false (undo grouping)", () => {
    const b = edit();
    b.newGroup = !b.newGroup;
    expect(verifyBlock(b)).toBe(false);
  });
  it("tampered structure → false", () => {
    const b = edit();
    b.structure = [{ from: 0, to: 99, ver: 1, group: 0 }];
    expect(verifyBlock(b)).toBe(false);
  });
  it("tampered caret → false (resolution cursor)", () => {
    const b = edit();
    b.caret = { before: 0, after: 0 };
    expect(verifyBlock(b)).toBe(false);
  });
  it("flipped kind undo→redo → false", () => {
    const b = parseBlock(serializeBlock(buildCommandBlock("undo", 1, "t")))!;
    (b as { kind: string }).kind = "redo";
    expect(verifyBlock(b)).toBe(false);
  });
});

describe("bloat-stats (§0.5.5)", () => {
  it("accrueStats: bytes + entries + undoCount + cancelledBytes", () => {
    let s = emptyStats();
    const e = buildEditBlock(1, "t", CHANGE, [], 1);
    s = accrueStats(s, e);
    expect(s.totalEntries).toBe(1);
    expect(s.undoCount).toBe(0);
    expect(s.cancelledBytes).toBe(0);
    expect(s.totalBytes).toBe(serializeBlock(e).length + 1);

    s = accrueStats(s, buildCommandBlock("undo", 2, "t"), 42);
    expect(s.totalEntries).toBe(2);
    expect(s.undoCount).toBe(1);
    expect(s.cancelledBytes).toBe(42);
  });

  it("shouldCompact: OR of undoCount / cancelledBytes thresholds", () => {
    expect(shouldCompact({ totalBytes: 0, totalEntries: 0, undoCount: 0, cancelledBytes: 0 })).toBe(false);
    expect(shouldCompact({ totalBytes: 0, totalEntries: 0, undoCount: 200, cancelledBytes: 0 })).toBe(true);
    expect(shouldCompact({ totalBytes: 0, totalEntries: 0, undoCount: 0, cancelledBytes: 1_000_000 })).toBe(true);
    expect(shouldCompact({ totalBytes: 0, totalEntries: 0, undoCount: 5, cancelledBytes: 5 }, { maxUndoCount: 4, maxCancelledBytes: 999 })).toBe(true);
  });
});

describe("HistoryWriterV2 — serialized append, no truncate (§0.5.2)", () => {
  let fx: { root: string; vault: Vault };
  const ID = "v2-hist";

  beforeEach(async () => {
    const root = path.join(os.tmpdir(), `histv2-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(root, { recursive: true });
    const vault = new MockVault(root) as unknown as Vault;
    await vault.adapter.writeBinary("base.md", new TextEncoder().encode("b\n").buffer as ArrayBuffer);
    await vault.adapter.writeBinary("sib.md", new TextEncoder().encode("s\n").buffer as ArrayBuffer);
    await startSession(vault, ID, "base.md", "sib.md", "2026-06-13T00:00:00.000Z");
    fx = { root, vault };
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const histPath = () => `${autosaveDir(ID)}/history.jsonl`;
  const readLines = async () => (await fx.vault.adapter.read(histPath())).split("\n").filter(Boolean);

  it("records edits + commands, drains, replay-parseable in order", async () => {
    const w = new HistoryWriterV2(fx.vault, ID);
    w.recordEdit(CHANGE, [], 1, "t1"); // typing burst start
    w.recordEdit(CHANGE, [], 0, "t2"); // coalesced
    w.recordCommand("undo", "t3", 7);
    expect(w.pendingCount()).toBe(3); // all queued before any append
    await w.drain();

    const lines = await readLines();
    expect(lines.length).toBe(3);
    const blocks = lines.map((l) => parseBlock(l)!);
    expect(blocks.every((b) => verifyBlock(b))).toBe(true);
    expect(blocks.map((b) => b.kind)).toEqual(["edit", "edit", "undo"]);
    expect((blocks[0] as { newGroup: boolean }).newGroup).toBe(true);
    expect((blocks[1] as { newGroup: boolean }).newGroup).toBe(false);
    expect(blocks.map((b) => b.seq)).toEqual([1, 2, 3]);

    const s = w.getStats();
    expect(s.totalEntries).toBe(3);
    expect(s.undoCount).toBe(1);
    expect(s.cancelledBytes).toBe(7);
  });

  it("startSeq continues the seq stamp (Resume-Continue)", async () => {
    const w = new HistoryWriterV2(fx.vault, ID, 5);
    w.recordEdit(CHANGE, [], 1, "t");
    await w.drain();
    expect((await readLines()).map((l) => parseBlock(l)!.seq)).toEqual([6]);
  });
});
