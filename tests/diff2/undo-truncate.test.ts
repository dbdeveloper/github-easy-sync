// @vitest-environment happy-dom
//
// TODO §5 — a CM6 undo must DROP the last history.jsonl block (truncate), so the
// log mirrors the editor's done-stack: on-disk block count == undoDepth(state)
// == writer.liveBlockCount(). Otherwise replay re-applies undone changes, the
// log grows unbounded on undo/redo cycling, and the net edit-count feeding
// §4.1.a exit-wipe / the recovery dialog is wrong.
//
// Oracle (per advisor): after EVERY step assert blockCount == undoDepth, and at
// the end replay-into-a-twin reproduces the LIVE resolved state.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { DiffPane } from "../../src/diff2/diff-pane";
import { HistoryWriter } from "../../src/diff2/history-log";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";

const containers: HTMLElement[] = [];
function mount(): HTMLElement {
  const c = document.createElement("div");
  document.body.appendChild(c);
  containers.push(c);
  return c;
}
const tmpdirs: string[] = [];
function fixture(): Vault {
  const root = path.join(os.tmpdir(), `undo-trunc-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  tmpdirs.push(root);
  return new MockVault(root) as unknown as Vault;
}
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Three diff groups separated by common lines.
const B = "n0\nM1\nn1\nM2\nn2\nM3\nn3\n";
const S = "n0\nT1\nn1\nT2\nn2\nT3\nn3\n";

const jsonlPath = (id: string) => `${autosaveDir(id)}/history.jsonl`;
const countBlocks = (j: string) => j.split("\n").filter((l) => l.trim() !== "").length;

async function diskBlocks(vault: Vault, id = "cid"): Promise<number> {
  const p = jsonlPath(id);
  if (!(await vault.adapter.exists(p))) return 0;
  return countBlocks(await vault.adapter.read(p));
}

// Wire a DiffPane to a HistoryWriter through the REAL onRecord/onUndo opts.
function wired(vault: Vault, base = B, sib = S, startSeq = 0) {
  const writer = new HistoryWriter(vault, "cid", startSeq);
  const pane = new DiffPane(mount(), base, sib, {
    onRecord: (c, s) => writer.record(c, s, "t"),
    onUndo: () => writer.truncateLastBlock(),
  });
  pane.enableRecording();
  return { writer, pane, view: pane.getView() };
}

describe("TODO §5 — undo truncates the last history.jsonl block", () => {
  it("3 edits → 2 undos → 1 block; replay reproduces the live state", async () => {
    const vault = fixture();
    await seed(vault);
    await startSession(vault, "cid", "base.md", "sibling.md");
    const { writer, pane, view } = wired(vault);

    pane.applyToChunk(0, "ours");
    pane.applyToChunk(1, "ours");
    pane.applyToChunk(2, "ours");
    expect(undoDepth(view.state)).toBe(3);
    expect(writer.liveBlockCount()).toBe(3);

    undo(view);
    undo(view);
    expect(undoDepth(view.state)).toBe(1);
    expect(writer.liveBlockCount()).toBe(1);

    await writer.drain();
    expect(await diskBlocks(vault)).toBe(1); // the two undone blocks are gone

    const liveResolved = { ...pane.getResolved() };
    const jsonl = await vault.adapter.read(jsonlPath("cid"));
    pane.destroy();

    const twin = new DiffPane(mount(), B, S);
    const r = twin.replayFrom(jsonl);
    expect(r.replayed).toBe(1); // ONLY the surviving change is replayed
    expect(twin.getResolved()).toEqual(liveResolved);
    twin.destroy();
  });

  it("undo to empty → 0 blocks, empty file, liveBlockCount 0 (couples to §4.1.a exit-wipe)", async () => {
    const vault = fixture();
    await seed(vault);
    await startSession(vault, "cid", "base.md", "sibling.md");
    const { writer, pane, view } = wired(vault);

    pane.applyToChunk(0, "ours");
    pane.applyToChunk(1, "ours");
    undo(view);
    undo(view);
    expect(undoDepth(view.state)).toBe(0);
    expect(writer.liveBlockCount()).toBe(0); // → exit-wipe discards, inputs untouched

    await writer.drain();
    expect(await vault.adapter.read(jsonlPath("cid"))).toBe(""); // empty, not deleted
    expect(await diskBlocks(vault)).toBe(0);
    pane.destroy();
  });

  it("redo re-appends (edit → undo → redo → 1 block); replay reproduces live", async () => {
    const vault = fixture();
    await seed(vault);
    await startSession(vault, "cid", "base.md", "sibling.md");
    const { writer, pane, view } = wired(vault);

    pane.applyToChunk(0, "ours");
    undo(view);
    expect(writer.liveBlockCount()).toBe(0);
    redo(view);
    expect(redoDepth(view.state)).toBe(0);
    expect(undoDepth(view.state)).toBe(1);
    expect(writer.liveBlockCount()).toBe(1);

    await writer.drain();
    expect(await diskBlocks(vault)).toBe(1);
    const liveResolved = { ...pane.getResolved() };
    const jsonl = await vault.adapter.read(jsonlPath("cid"));
    pane.destroy();
    const twin = new DiffPane(mount(), B, S);
    twin.replayFrom(jsonl);
    expect(twin.getResolved()).toEqual(liveResolved);
    twin.destroy();
  });

  it("edit-after-undo replaces the abandoned branch (e0,e1 → undo → e2 → [b0,b2])", async () => {
    const vault = fixture();
    await seed(vault);
    await startSession(vault, "cid", "base.md", "sibling.md");
    const { writer, pane, view } = wired(vault);

    pane.applyToChunk(0, "ours");
    pane.applyToChunk(1, "ours");
    undo(view); // drop b1 (group 1 unresolved again)
    pane.applyToChunk(2, "ours"); // new edit → CM6 cleared redo → append b2
    expect(undoDepth(view.state)).toBe(2);
    expect(writer.liveBlockCount()).toBe(2);

    await writer.drain();
    expect(await diskBlocks(vault)).toBe(2);
    const liveResolved = { ...pane.getResolved() };
    const jsonl = await vault.adapter.read(jsonlPath("cid"));
    pane.destroy();
    const twin = new DiffPane(mount(), B, S);
    twin.replayFrom(jsonl);
    expect(twin.getResolved()).toEqual(liveResolved); // groups 0 + 2 resolved, 1 not
    twin.destroy();
  });

  it("undo into a RESUMED session's prior blocks shrinks the file (re-read, not in-memory)", async () => {
    const vault = fixture();
    await seed(vault);
    await startSession(vault, "cid", "base.md", "sibling.md");
    // Session 1: produce 3 blocks on disk.
    {
      const { writer, pane } = wired(vault);
      pane.applyToChunk(0, "ours");
      pane.applyToChunk(1, "ours");
      pane.applyToChunk(2, "ours");
      await writer.drain();
      pane.destroy();
    }
    const priorJsonl = await vault.adapter.read(jsonlPath("cid"));
    expect(countBlocks(priorJsonl)).toBe(3);

    // Session 2 (resume): writer continues at startSeq=3, pane replays the prior
    // blocks (rebuilding the CM6 undo stack), then the user undoes INTO them.
    const writer = new HistoryWriter(vault, "cid", 3);
    const pane = new DiffPane(mount(), B, S, {
      onRecord: (c, s) => writer.record(c, s, "t"),
      onUndo: () => writer.truncateLastBlock(),
    });
    pane.replayFrom(priorJsonl);
    pane.enableRecording();
    const view = pane.getView();
    expect(undoDepth(view.state)).toBe(3);
    expect(writer.liveBlockCount()).toBe(3);

    undo(view); // undo a PRIOR (resumed) block — writer has it only on disk
    expect(writer.liveBlockCount()).toBe(2);
    await writer.drain();
    expect(await diskBlocks(vault)).toBe(2); // re-read+rewrite dropped the prior block
    pane.destroy();
  });

  it("fuzz: blockCount == undoDepth after every op, and replay == live at the end", async () => {
    const vault = fixture();
    await seed(vault);
    await startSession(vault, "cid", "base.md", "sibling.md");
    const { writer, pane, view } = wired(vault);

    // Deterministic LCG so the run is reproducible.
    let s = 12345;
    const rng = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

    for (let i = 0; i < 120; i++) {
      const r = rng();
      if (r < 0.5) {
        // forward free-edit at doc start (always recordable + undoable)
        view.dispatch({ changes: { from: 0, insert: "x" } });
      } else if (r < 0.75 && undoDepth(view.state) > 0) {
        undo(view);
      } else if (redoDepth(view.state) > 0) {
        redo(view);
      } else {
        view.dispatch({ changes: { from: 0, insert: "y" } });
      }
      // Oracle: the in-memory live count tracks CM6's undo depth exactly.
      expect(writer.liveBlockCount()).toBe(undoDepth(view.state));
    }

    await writer.drain();
    expect(await diskBlocks(vault)).toBe(undoDepth(view.state)); // on-disk == undoDepth
    const liveResolved = { ...pane.getResolved() };
    const jsonl = await vault.adapter.read(jsonlPath("cid"));
    pane.destroy();
    const twin = new DiffPane(mount(), B, S);
    twin.replayFrom(jsonl);
    expect(twin.getResolved()).toEqual(liveResolved); // replay reproduces live
    twin.destroy();
  });
});

// Seed base/sibling vault files for startSession; returns nothing useful but the
// (call sites do `await seed(vault)` before startSession).
async function seed(vault: Vault): Promise<object> {
  await vault.adapter.write("base.md", B);
  await vault.adapter.write("sibling.md", S);
  return {};
}
