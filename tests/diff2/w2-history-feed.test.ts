// @vitest-environment happy-dom
//
// W2 — DiffPane history feed through its OWN production wiring (DIFF-EDITOR.md
// §2.6–§2.8). The W4a test proved a hand-rolled listener; this proves the real
// `onRecord` → HistoryWriter → `history.jsonl` path emits a replayable file, and
// that the two guards against the record→replay→re-record loop hold.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { DiffPane } from "../../src/diff2/diff-pane";
import { HistoryWriter } from "../../src/diff2/history-log";
import {
  readResumeSession,
  startSession,
} from "../../src/diff2/autosave-store";

const containers: HTMLElement[] = [];
function mount(): HTMLElement {
  const c = document.createElement("div");
  document.body.appendChild(c);
  containers.push(c);
  return c;
}
const tmpdirs: string[] = [];
function fixture(): Vault {
  const root = path.join(
    os.tmpdir(),
    `w2-feed-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  tmpdirs.push(root);
  return new MockVault(root) as unknown as Vault;
}
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const BASE = "a\nMINE\nc\n";
const SIB = "a\nTHEIRS\nc\n";

async function session(vault: Vault): Promise<void> {
  await vault.adapter.write("base.md", BASE);
  await vault.adapter.write("sibling.md", SIB);
  await startSession(vault, "cid", "base.md", "sibling.md");
}

describe("W2 — DiffPane history feed (production wiring)", () => {
  it("centerpiece: live edits → real history.jsonl → replay into a twin reproduces resolved", async () => {
    const vault = fixture();
    await session(vault);
    const writer = new HistoryWriter(vault, "cid");
    const pane = new DiffPane(mount(), BASE, SIB, {
      onRecord: (change, structure) =>
        writer.record(change, structure, "2026-06-04T00:00:00.000Z"),
    });
    pane.enableRecording();

    pane.resolveAll("ours"); // live edit → onRecord → writer
    const liveResolved = { ...pane.getResolved() };
    await writer.drain();
    pane.destroy();

    // The production path actually emitted a replayable file on disk.
    const sess = await readResumeSession(vault, "cid");
    expect(sess.jsonl.length).toBeGreaterThan(0);

    const twin = new DiffPane(mount(), BASE, SIB);
    const r = twin.replayFrom(sess.jsonl);
    expect(r.stoppedAtCorrupt).toBe(false);
    expect(r.replayed).toBeGreaterThan(0);
    expect(twin.getResolved()).toEqual(liveResolved);
    twin.destroy();
  });

  it("replay-not-recorded: replayFrom + setCursor never fire onRecord (both guards)", async () => {
    const vault = fixture();
    await session(vault);
    // produce a non-empty history first
    const writer = new HistoryWriter(vault, "cid");
    const src = new DiffPane(mount(), BASE, SIB, {
      onRecord: (c, s) => writer.record(c, s, "t"),
    });
    src.enableRecording();
    src.resolveAll("ours");
    await writer.drain();
    const jsonl = (await readResumeSession(vault, "cid")).jsonl;
    src.destroy();
    expect(jsonl.length).toBeGreaterThan(0);

    // A spy pane: replay + setCursor must NOT record. recording is OFF during
    // replay (guard 1), and setState carries no transactions (guard 2).
    let calls = 0;
    const twin = new DiffPane(mount(), BASE, SIB, { onRecord: () => calls++ });
    twin.replayFrom(jsonl);
    twin.setCursor(1, 1);
    expect(calls).toBe(0);
    // Even after enabling, the already-done replay/setCursor produced nothing.
    twin.enableRecording();
    expect(calls).toBe(0);
    twin.destroy();
  });

  it("fresh-mount: construct + enableRecording + no user edit → zero blocks", () => {
    let calls = 0;
    const pane = new DiffPane(mount(), BASE, SIB, { onRecord: () => calls++ });
    pane.enableRecording();
    expect(calls).toBe(0); // no spurious init/layout transaction recorded
    pane.destroy();
  });

  it("a resolution records; a selection-only move does NOT", () => {
    const blocks: unknown[] = [];
    const pane = new DiffPane(mount(), BASE, SIB, {
      onRecord: (change) => blocks.push(change),
    });
    pane.enableRecording();
    pane.resolveAll("ours"); // structure (+doc) change → records ≥1
    const afterResolve = blocks.length;
    expect(afterResolve).toBeGreaterThan(0);
    // all diffs resolved → caret lands in normal text → selection-only, no
    // setDiffPaneState → not recorded.
    pane.setCursor(0, 0);
    expect(blocks.length).toBe(afterResolve);
    pane.destroy();
  });

  it("recording disabled → edits are not recorded", () => {
    let calls = 0;
    const pane = new DiffPane(mount(), BASE, SIB, { onRecord: () => calls++ });
    // NOT enabled
    pane.resolveAll("ours");
    expect(calls).toBe(0);
    pane.destroy();
  });
});
