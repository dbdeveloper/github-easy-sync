// @vitest-environment happy-dom
//
// W1 end-to-end: the DiffEditView `[←]` commit WIRING chain, with the REAL
// DiffPane (happy-dom CM6) and a REAL fs-backed vault. Exercises exactly what
// mountDiffPane + exitDetailView glue together — id derivation → startSession →
// DiffPane.getResolved() → classifyToctou → commit7Step → vault outcome — which
// is the one real regression surface of swapping the naive exit-protocol for
// the 7-step pair-atomic commit. The 7-step internals + recovery matrix are
// covered by exit-commit*.test.ts; here we assert the chain's net effect.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { DiffPane } from "../../src/diff2/diff-pane";
import {
  autosaveIdForEntry,
  type ConflictEntry,
} from "../../src/diff2/synthetic-detector";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import { classifyToctou, commit7Step } from "../../src/diff2/exit-commit";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `view-commit-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

function entryFor(basePath: string, siblingPath: string): ConflictEntry {
  return {
    basePath,
    siblingPath,
    deviceLabel: "Phone",
    isoTimestamp: "2026-06-03T10-30-00Z",
    kind: "synthetic",
  };
}

// Replays mountDiffPane's session setup + exitDetailView's commit, with the
// real DiffPane in between (the glue under test). `resolve` performs the user's
// in-editor actions before `[←]`.
async function mountResolveCommit(
  vault: Vault,
  container: HTMLElement,
  basePath: string,
  siblingPath: string,
  ours: string,
  theirs: string,
  resolve: (pane: DiffPane) => void,
) {
  const entry = entryFor(basePath, siblingPath);
  const conflictId = autosaveIdForEntry(entry);
  const meta = await startSession(vault, conflictId, basePath, siblingPath);

  const pane = new DiffPane(container, ours, theirs, {
    oursLabel: "local",
    theirsLabel: entry.deviceLabel,
    isMarkdown: true,
    joinContext: {
      remoteDeviceLabel: entry.deviceLabel,
      timestamp: entry.isoTimestamp,
    },
  });
  try {
    resolve(pane);
    const resolved = pane.getResolved();
    const toctou = await classifyToctou(vault, meta);
    return { conflictId, meta, resolved, toctou, pane };
  } finally {
    // caller destroys after commit (needs pane alive for getResolved)
  }
}

describe("DiffEditView [←] commit wiring (W1 e2e)", () => {
  let fx: ReturnType<typeof fixture>;
  let container: HTMLElement;

  beforeEach(() => {
    fx = fixture();
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it("resolve-all → both sides converge: base written, sibling removed, autosave dir gone", async () => {
    const basePath = "Notes/x.md";
    const siblingPath = "Notes/x.conflict-from-Phone-2026-06-03T10-30-00Z.md";
    await fx.vault.adapter.writeBinary(basePath, enc("a\nMINE\nc\n"));
    await fx.vault.adapter.writeBinary(siblingPath, enc("a\nTHEIRS\nc\n"));

    const { conflictId, meta, resolved, toctou, pane } =
      await mountResolveCommit(
        fx.vault,
        container,
        basePath,
        siblingPath,
        "a\nMINE\nc\n",
        "a\nTHEIRS\nc\n",
        (p) => p.resolveAll("ours"),
      );

    expect(toctou.kind).toBe("ok");
    expect(resolved.base).toBe(resolved.sibling); // converged on "ours"

    const result = await commit7Step(fx.vault, conflictId, meta, resolved);
    pane.destroy();

    // base file holds the resolved bytes…
    expect(dec(await fx.vault.adapter.readBinary(basePath))).toBe(resolved.base);
    // …the now-redundant sibling is removed (§6.5)…
    expect(result.siblingRemoved).toBe(true);
    expect(await fx.vault.adapter.exists(siblingPath)).toBe(false);
    // …and the autosave dir is torn down (Step 7).
    expect(await fx.vault.adapter.exists(autosaveDir(conflictId))).toBe(false);
  });

  it("sides NOT converged: both written, sibling kept (no spurious cleanup)", async () => {
    const basePath = "Notes/y.md";
    const siblingPath = "Notes/y.conflict-from-Phone-2026-06-03T10-30-00Z.md";
    await fx.vault.adapter.writeBinary(basePath, enc("a\nMINE\nc\n"));
    await fx.vault.adapter.writeBinary(siblingPath, enc("a\nTHEIRS\nc\n"));

    const { conflictId, meta, resolved, pane } = await mountResolveCommit(
      fx.vault,
      container,
      basePath,
      siblingPath,
      "a\nMINE\nc\n",
      "a\nTHEIRS\nc\n",
      () => {
        /* leave the conflict unresolved — [←] saves both sides as-is */
      },
    );

    expect(resolved.base).not.toBe(resolved.sibling);

    const result = await commit7Step(fx.vault, conflictId, meta, resolved);
    pane.destroy();

    expect(result.siblingRemoved).toBe(false);
    expect(await fx.vault.adapter.exists(siblingPath)).toBe(true);
    expect(dec(await fx.vault.adapter.readBinary(basePath))).toBe(resolved.base);
    expect(dec(await fx.vault.adapter.readBinary(siblingPath))).toBe(
      resolved.sibling,
    );
    expect(await fx.vault.adapter.exists(autosaveDir(conflictId))).toBe(false);
  });

  it("TOCTOU: base rewritten on disk after startSession → classifyToctou mismatch (view aborts)", async () => {
    const basePath = "Notes/z.md";
    const siblingPath = "Notes/z.conflict-from-Phone-2026-06-03T10-30-00Z.md";
    await fx.vault.adapter.writeBinary(basePath, enc("a\nMINE\nc\n"));
    await fx.vault.adapter.writeBinary(siblingPath, enc("a\nTHEIRS\nc\n"));

    const entry = entryFor(basePath, siblingPath);
    const conflictId = autosaveIdForEntry(entry);
    const meta = await startSession(fx.vault, conflictId, basePath, siblingPath);

    // A sync rewrites base under us AFTER the session started.
    await fx.vault.adapter.writeBinary(basePath, enc("a\nSYNCED\nc\n"));

    const toctou = await classifyToctou(fx.vault, meta);
    expect(toctou.kind).toBe("mismatch");
    if (toctou.kind === "mismatch") {
      expect(toctou.baseChanged).toBe(true);
      expect(toctou.siblingChanged).toBe(false);
    }
    // The view bails without committing → autosave dir survives for reopen.
    expect(await fx.vault.adapter.exists(autosaveDir(conflictId))).toBe(true);
  });
});
