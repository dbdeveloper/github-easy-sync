// @vitest-environment happy-dom
//
// TODO §2 regression: reopening a conflict whose autosave session has ZERO
// trustworthy edits must NOT surface the "Resume previous edit session? · 0
// edits saved" modal (DIFF-EDITOR.md §3.5: "history.jsonl має 0 рядків → Modal
// не показуємо; видалити stale autosave; fresh session").
//
// mountDiffPane is private ItemView glue with no mount harness, so this pins the
// exact DECISION the view makes — classifyReopen → reopenAction → the
// `assessHistory(jsonl).empty` skip-modal gate — against a real fs-backed vault,
// mirroring diff-edit-view-commit.test.ts's "replay the glue" approach.

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
  classifyReopen,
  readResumeSession,
  startSession,
} from "../../src/diff2/autosave-store";
import { reopenAction } from "../../src/diff2/reopen-action";
import { assessHistory } from "../../src/diff2/history-replay";

const tmpdirs: string[] = [];
const containers: HTMLElement[] = [];
function fixture(): Vault {
  const root = path.join(
    os.tmpdir(),
    `reopen-empty-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  tmpdirs.push(root);
  return new MockVault(root) as unknown as Vault;
}
function mount(): HTMLElement {
  const c = document.createElement("div");
  document.body.appendChild(c);
  containers.push(c);
  return c;
}
afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("TODO §2 — reopen with empty history.jsonl skips the resume modal", () => {
  it("a fresh, unedited session classifies as resume but its history is empty → modal skipped", async () => {
    const vault = fixture();
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    await vault.adapter.write("base.md", base);
    await vault.adapter.write("sibling.md", sibling);
    await startSession(vault, "cid", "base.md", "sibling.md");

    // Reopen: the vault is unchanged since session start → classifyReopen
    // returns "resume" (it does NOT inspect history depth — that is the view's
    // job), and reopenAction maps it to the modal-bearing "resume" action.
    const status = await classifyReopen(vault, "cid", "base.md", "sibling.md");
    expect(status.kind).toBe("resume");
    expect(reopenAction(status).kind).toBe("resume");

    // But history.jsonl is empty → the view's skip-modal gate fires, so no
    // "Resume previous edit session? · 0 edits" dialog is shown; the view
    // wipes + starts fresh instead.
    const sess = await readResumeSession(vault, "cid");
    expect(sess.jsonl).toBe("");
    expect(assessHistory(sess.jsonl).empty).toBe(true);
  });

  it("after one recorded edit the gate does NOT fire (modal would show)", async () => {
    const vault = fixture();
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    await vault.adapter.write("base.md", base);
    await vault.adapter.write("sibling.md", sibling);
    await startSession(vault, "cid", "base.md", "sibling.md");

    // Record one real edit into history.jsonl (the W2 feed shape).
    const pane = new DiffPane(mount(), base, sibling);
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
    pane.resolveAll("ours");
    const jsonl = blocks
      .map((b, i) =>
        serializeHistoryBlock(i + 1, "2026-06-05T00:00:00.000Z", b.change, b.structure),
      )
      .join("\n");
    await vault.adapter.write(`${autosaveDir("cid")}/history.jsonl`, jsonl);
    pane.destroy();

    const sess = await readResumeSession(vault, "cid");
    expect(sess.jsonl.length).toBeGreaterThan(0);
    expect(assessHistory(sess.jsonl).empty).toBe(false); // modal WOULD show
  });
});
