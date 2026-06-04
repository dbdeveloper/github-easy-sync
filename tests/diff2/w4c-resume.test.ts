// @vitest-environment happy-dom
//
// W4c Step C — resume via readResumeSession + replay (DIFF-EDITOR.md §3.2 / §3.3).
//
// End-to-end through the autosave DIR (the W4a twin pattern extended to the
// snapshot-build entry, per the advisor): startSession writes the snapshots,
// edits are recorded to history.jsonl, then readResumeSession reads them back and
// a TWIN DiffPane replays. The replayed resolved state must reproduce the live
// one — which IS exactly the {base, sibling} bytes the [← back] commit path
// consumes (the replay→commit seam).
//
// happy-dom for the DiffPane DOM + the fs-backed mock-obsidian Vault for the dir.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { DiffPane } from "../../src/diff2/diff-pane";
import {
  diffPaneStateField,
  setDiffPaneState,
} from "../../src/diff2/decorations";
import { serializeHistoryBlock } from "../../src/diff2/history-log";
import type { Segment } from "../../src/diff2/editor-model";
import {
  autosaveDir,
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
    `w4c-resume-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  tmpdirs.push(root);
  return new MockVault(root) as unknown as Vault;
}

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Record one history block per recordable transaction — the exact {change,
// structure} shape W2's updateListener will feed HistoryWriter — and serialize
// through the Stage-3a writer.
function record(
  pane: DiffPane,
  ops: (pane: DiffPane, view: EditorView) => void,
): string {
  const view = pane.getView();
  const blocks: { change: unknown; structure: Segment[] }[] = [];
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions) {
          if (!tr.docChanged && !tr.effects.some((e) => e.is(setDiffPaneState))) {
            continue;
          }
          blocks.push({
            change: tr.changes.toJSON(),
            structure: u.state.field(diffPaneStateField)!.structure,
          });
        }
      }),
    ),
  });
  ops(pane, view);
  return blocks
    .map((b, i) =>
      serializeHistoryBlock(
        i + 1,
        "2026-06-04T00:00:00.000Z",
        b.change,
        b.structure,
      ),
    )
    .join("\n");
}

describe("W4c Step C — resume via readResumeSession + replay", () => {
  it("reads snapshots back, replays history, reproduces live resolved (= commit bytes)", async () => {
    const vault = fixture();
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    await vault.adapter.write("base.md", base);
    await vault.adapter.write("sibling.md", sibling);
    await startSession(vault, "cid", "base.md", "sibling.md");

    // readResumeSession reproduces the session-start doc exactly (decode matches).
    const sess0 = await readResumeSession(vault, "cid");
    expect(sess0.base).toBe(base);
    expect(sess0.sibling).toBe(sibling);
    expect(sess0.jsonl).toBe(""); // empty history — W2 feed not wired yet

    // live: build from the snapshots, resolve, capture history → write to dir.
    const live = new DiffPane(mount(), sess0.base, sess0.sibling);
    const jsonl = record(live, (p) => p.resolveAll("ours"));
    expect(jsonl.length).toBeGreaterThan(0);
    const liveResolved = { ...live.getResolved() };
    await vault.adapter.write(`${autosaveDir("cid")}/history.jsonl`, jsonl);
    live.destroy();

    // resume: readResumeSession (dir read-back) + twin replay.
    const sess = await readResumeSession(vault, "cid");
    expect(sess.jsonl).toBe(jsonl); // history.jsonl round-tripped through the dir
    const twin = new DiffPane(mount(), sess.base, sess.sibling);
    const r = twin.replayFrom(sess.jsonl);
    expect(r.stoppedAtCorrupt).toBe(false);
    expect(r.replayed).toBeGreaterThan(0);

    // The replayed resolved state reproduces the live one — and getResolved()
    // {base, sibling} IS exactly what the [← back] commit path writes (the seam).
    const replayed = twin.getResolved();
    expect(replayed).toEqual(liveResolved);
    expect(replayed).toHaveProperty("base");
    expect(replayed).toHaveProperty("sibling");
    twin.destroy();
  });

  it("empty history.jsonl → continue is a no-op replay (W2 inert today)", async () => {
    const vault = fixture();
    const base = "x\nM\ny\n";
    const sibling = "x\nT\ny\n";
    await vault.adapter.write("base.md", base);
    await vault.adapter.write("sibling.md", sibling);
    await startSession(vault, "cid", "base.md", "sibling.md");

    const sess = await readResumeSession(vault, "cid");
    expect(sess.jsonl).toBe("");
    const twin = new DiffPane(mount(), sess.base, sess.sibling);
    const before = { ...twin.getResolved() };
    expect(twin.replayFrom(sess.jsonl)).toEqual({
      replayed: 0,
      stoppedAtCorrupt: false,
    });
    expect(twin.getResolved()).toEqual(before); // unchanged session-start state
    twin.destroy();
  });

  // §3.2.a base-changed recreation. The view glue is manual; here we pin the
  // session-recreation OUTCOME: which (base, sibling) the new session snapshots.
  it("§3.2.a Continue: restored sibling written + recreated → new base vs restored sibling", async () => {
    const vault = fixture();
    const oldBase = "a\nMINE\nc\n";
    const oldSibling = "a\nTHEIRS\nc\n";
    await vault.adapter.write("base.md", oldBase);
    await vault.adapter.write("sibling.md", oldSibling);
    await startSession(vault, "cid", "base.md", "sibling.md");

    // user resolves in the editor → restoredSibling = getResolved().sibling
    const sess0 = await readResumeSession(vault, "cid");
    const pane = new DiffPane(mount(), sess0.base, sess0.sibling);
    pane.resolveAll("ours");
    const restoredSibling = pane.getResolved().sibling;
    pane.destroy();

    // base changed in the vault (user edited it directly after a crash, §7)
    const newBase = "a\nMINE\nc\nNEW\n";
    await vault.adapter.write("base.md", newBase);

    // Continue: write the restored sibling onto the vault, rmdir, startSession.
    await vault.adapter.write("sibling.md", restoredSibling);
    await vault.adapter.rmdir(autosaveDir("cid"), true);
    await startSession(vault, "cid", "base.md", "sibling.md");

    const sess = await readResumeSession(vault, "cid");
    expect(sess.base).toBe(newBase); // NEW base — never restored/overwritten
    expect(sess.sibling).toBe(restoredSibling); // restored sibling carried forward
    expect(sess.jsonl).toBe(""); // fresh session, empty history
  });

  it("§3.2.a Start over: recreate with the ORIGINAL (untouched) sibling", async () => {
    const vault = fixture();
    const oldBase = "a\nMINE\nc\n";
    const oldSibling = "a\nTHEIRS\nc\n";
    await vault.adapter.write("base.md", oldBase);
    await vault.adapter.write("sibling.md", oldSibling);
    await startSession(vault, "cid", "base.md", "sibling.md");

    const newBase = "a\nMINE\nc\nNEW\n";
    await vault.adapter.write("base.md", newBase);

    // Start over: rmdir + startSession — the sibling is NOT overwritten.
    await vault.adapter.rmdir(autosaveDir("cid"), true);
    await startSession(vault, "cid", "base.md", "sibling.md");

    const sess = await readResumeSession(vault, "cid");
    expect(sess.base).toBe(newBase);
    expect(sess.sibling).toBe(oldSibling); // original, untouched
  });
});
