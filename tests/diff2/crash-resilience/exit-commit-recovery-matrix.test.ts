// Stage 2.1 — recoverCommit() across the full §5.0.b A–K decision matrix.
//
// Recovery is a PURE function of disk state. We hand-craft each row's exact
// on-disk slot configuration (final / .sync-tmp / .sync-bak × old/new/torn/
// foreign/absent), run recoverCommit, and assert the vault converges to the
// committed end-state (forward rows D–K) or cleanly rolls back (A–C) /
// falls back (foreign). Hand-crafting is the ONLY way to reach the torn-write
// rows B/C and the external-modification fallback — crash injection at await
// boundaries can never produce a partial .sync-tmp. A secondary injection test
// then proves commit7Step's real crash points land WITHIN the matrix.
//
// Node env (real fs over tmpdir), composing Stage 2.0 startSession so meta's
// baseShaAtStart/siblingShaAtStart are the real session-start SHAs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault, setMockPlatform } from "../../../mock-obsidian";
import type { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../../../src/utils";
import { stagingPathFor } from "../../../src/sync2/atomic-write";
import { autosaveDir, startSession } from "../../../src/diff2/autosave-store";
import { commit7Step, recoverCommit } from "../../../src/diff2/exit-commit";

const NOW = "2026-06-02T12:00:00.000Z";
const ID = "tracked-recover";
const BASE = "Notes/doc.md";
const SIB = "Notes/doc.conflict-from-Phone-X.md";

const OLD_BASE = "old base\n";
const OLD_SIB = "old sib\n";
const NEW_BASE = "new base\n";
const NEW_SIB = "new sib\n";
const TORN = "torn partial\n";
const FOREIGN = "external content\n";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function fixture() {
  const root = path.join(os.tmpdir(), `recover-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

type FinalSlot = "absent" | "old" | "new" | "foreign";
type TmpSlot = "absent" | "tmpNew" | "tmpTorn";

// Build the meta + done.json, then place each side's three slots exactly.
async function craft(
  vault: Vault,
  base: { final: FinalSlot; tmp: TmpSlot; bak: boolean },
  sib: { final: FinalSlot; tmp: TmpSlot; bak: boolean },
  opts: { writeDone?: boolean; newBase?: string; newSib?: string } = {},
) {
  const newBase = opts.newBase ?? NEW_BASE;
  const newSib = opts.newSib ?? NEW_SIB;
  // Seed originals so startSession records meta SHAs = SHA(OLD_*).
  await vault.adapter.writeBinary(BASE, enc(OLD_BASE));
  await vault.adapter.writeBinary(SIB, enc(OLD_SIB));
  await startSession(vault, ID, BASE, SIB, NOW);

  if (opts.writeDone !== false) {
    await vault.adapter.write(
      `${autosaveDir(ID)}/done.json`,
      JSON.stringify({
        v: 1,
        writtenAt: NOW,
        expectedBaseSha: await calculateGitBlobSHA(enc(newBase)),
        expectedSiblingSha: await calculateGitBlobSHA(enc(newSib)),
      }),
    );
  }

  // Wipe the seeded originals; re-place exactly the requested slots.
  await vault.adapter.remove(BASE);
  await vault.adapter.remove(SIB);
  await placeSide(vault, BASE, base, OLD_BASE, newBase);
  await placeSide(vault, SIB, sib, OLD_SIB, newSib);
}

async function placeSide(
  vault: Vault,
  finalPath: string,
  slot: { final: FinalSlot; tmp: TmpSlot; bak: boolean },
  oldBytes: string,
  newBytes: string,
) {
  if (slot.final === "old") await vault.adapter.writeBinary(finalPath, enc(oldBytes));
  else if (slot.final === "new") await vault.adapter.writeBinary(finalPath, enc(newBytes));
  else if (slot.final === "foreign") await vault.adapter.writeBinary(finalPath, enc(FOREIGN));

  if (slot.tmp === "tmpNew")
    await vault.adapter.writeBinary(stagingPathFor(finalPath, "tmp"), enc(newBytes));
  else if (slot.tmp === "tmpTorn")
    await vault.adapter.writeBinary(stagingPathFor(finalPath, "tmp"), enc(TORN));

  if (slot.bak) await vault.adapter.writeBinary(stagingPathFor(finalPath, "bak"), enc(oldBytes));
}

async function assertCommitted(vault: Vault) {
  expect(await vault.adapter.read(BASE)).toBe(NEW_BASE);
  expect(await vault.adapter.read(SIB)).toBe(NEW_SIB);
  for (const w of ["tmp", "bak"] as const) {
    expect(await vault.adapter.exists(stagingPathFor(BASE, w))).toBe(false);
    expect(await vault.adapter.exists(stagingPathFor(SIB, w))).toBe(false);
  }
  expect(await vault.adapter.exists(autosaveDir(ID))).toBe(false);
}

describe("recoverCommit — forward rows D–K converge to committed", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const FORWARD: Array<[
    string,
    { final: FinalSlot; tmp: TmpSlot; bak: boolean },
    { final: FinalSlot; tmp: TmpSlot; bak: boolean },
  ]> = [
    ["D (both tmp✓, finals old)", { final: "old", tmp: "tmpNew", bak: false }, { final: "old", tmp: "tmpNew", bak: false }],
    ["E (base renamed first)", { final: "absent", tmp: "tmpNew", bak: true }, { final: "old", tmp: "tmpNew", bak: false }],
    ["F (sibling renamed first)", { final: "old", tmp: "tmpNew", bak: false }, { final: "absent", tmp: "tmpNew", bak: true }],
    ["G (both renamed to bak)", { final: "absent", tmp: "tmpNew", bak: true }, { final: "absent", tmp: "tmpNew", bak: true }],
    ["H (base committed first)", { final: "new", tmp: "absent", bak: true }, { final: "absent", tmp: "tmpNew", bak: true }],
    ["I (sibling committed first)", { final: "absent", tmp: "tmpNew", bak: true }, { final: "new", tmp: "absent", bak: true }],
    ["J (both committed, baks remain)", { final: "new", tmp: "absent", bak: true }, { final: "new", tmp: "absent", bak: true }],
    ["K (both committed, baks gone)", { final: "new", tmp: "absent", bak: false }, { final: "new", tmp: "absent", bak: false }],
  ];

  for (const [name, base, sib] of FORWARD) {
    it(`${name} → rolled-forward`, async () => {
      await craft(fx.vault, base, sib);
      const res = await recoverCommit(fx.vault, ID);
      expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: false });
      await assertCommitted(fx.vault);
    });
  }
});

describe("recoverCommit — rollback rows A–C preserve the session", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  const ROLLBACK: Array<[
    string,
    { final: FinalSlot; tmp: TmpSlot; bak: boolean },
    { final: FinalSlot; tmp: TmpSlot; bak: boolean },
  ]> = [
    ["A (pre-write, both old)", { final: "old", tmp: "absent", bak: false }, { final: "old", tmp: "absent", bak: false }],
    ["B (both torn)", { final: "old", tmp: "tmpTorn", bak: false }, { final: "old", tmp: "tmpTorn", bak: false }],
    ["C (one torn, one good)", { final: "old", tmp: "tmpTorn", bak: false }, { final: "old", tmp: "tmpNew", bak: false }],
  ];

  for (const [name, base, sib] of ROLLBACK) {
    it(`${name} → rolled-back, originals intact, session kept`, async () => {
      await craft(fx.vault, base, sib);
      const res = await recoverCommit(fx.vault, ID);
      expect(res).toEqual({ kind: "rolled-back" });

      // Originals untouched at their final paths.
      expect(await fx.vault.adapter.read(BASE)).toBe(OLD_BASE);
      expect(await fx.vault.adapter.read(SIB)).toBe(OLD_SIB);
      // Partial staging + barrier gone; session (meta) preserved.
      expect(await fx.vault.adapter.exists(stagingPathFor(BASE, "tmp"))).toBe(false);
      expect(await fx.vault.adapter.exists(stagingPathFor(SIB, "tmp"))).toBe(false);
      expect(await fx.vault.adapter.exists(`${autosaveDir(ID)}/done.json`)).toBe(false);
      expect(await fx.vault.adapter.exists(`${autosaveDir(ID)}/meta.json`)).toBe(true);
    });
  }
});

describe("recoverCommit — fallback, 6.5-in-recovery, no-commit", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("foreign final (external modification) → fallback, foreign content left intact", async () => {
    // base.final externally overwritten (neither old nor new) but base.tmp✓.
    await craft(
      fx.vault,
      { final: "foreign", tmp: "tmpNew", bak: false },
      { final: "old", tmp: "tmpNew", bak: false },
    );
    const res = await recoverCommit(fx.vault, ID);
    expect(res).toEqual({ kind: "fallback", reason: "external-modification" });
    // The foreign content survives; our staging + session dir are gone.
    expect(await fx.vault.adapter.read(BASE)).toBe(FOREIGN);
    expect(await fx.vault.adapter.exists(stagingPathFor(BASE, "tmp"))).toBe(false);
    expect(await fx.vault.adapter.exists(stagingPathFor(SIB, "tmp"))).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
  });

  it("forward with identical committed sides → step 6.5 removes the sibling", async () => {
    await craft(
      fx.vault,
      { final: "old", tmp: "tmpNew", bak: false },
      { final: "old", tmp: "tmpNew", bak: false },
      { newBase: "MERGED\n", newSib: "MERGED\n" },
    );
    const res = await recoverCommit(fx.vault, ID);
    expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: true });
    expect(await fx.vault.adapter.read(BASE)).toBe("MERGED\n");
    expect(await fx.vault.adapter.exists(SIB)).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
  });

  it("no done.json → no-commit, nothing touched", async () => {
    await craft(
      fx.vault,
      { final: "old", tmp: "absent", bak: false },
      { final: "old", tmp: "absent", bak: false },
      { writeDone: false },
    );
    const res = await recoverCommit(fx.vault, ID);
    expect(res).toEqual({ kind: "no-commit" });
    expect(await fx.vault.adapter.read(BASE)).toBe(OLD_BASE);
    expect(await fx.vault.adapter.exists(`${autosaveDir(ID)}/meta.json`)).toBe(true);
  });
});

describe("recoverCommit under MOCK_PLATFORM=mobile (Capacitor rename)", () => {
  // roll-forward does safeRename(tmp → final) OVER an existing old final
  // (row D) — a rename-over-occupied path, exactly what the CLAUDE.md mobile
  // rule guards. Confirm it (and the foreign fallback) under strict semantics.
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => {
    setMockPlatform("mobile");
    fx = fixture();
  });
  afterEach(() => {
    setMockPlatform("desktop");
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it("row D (rename over occupied final) rolls forward", async () => {
    await craft(
      fx.vault,
      { final: "old", tmp: "tmpNew", bak: false },
      { final: "old", tmp: "tmpNew", bak: false },
    );
    expect(await recoverCommit(fx.vault, ID)).toEqual({
      kind: "rolled-forward",
      siblingRemoved: false,
    });
    await assertCommitted(fx.vault);
  });

  it("foreign final → fallback, foreign content intact", async () => {
    await craft(
      fx.vault,
      { final: "foreign", tmp: "tmpNew", bak: false },
      { final: "old", tmp: "tmpNew", bak: false },
    );
    expect(await recoverCommit(fx.vault, ID)).toEqual({
      kind: "fallback",
      reason: "external-modification",
    });
    expect(await fx.vault.adapter.read(BASE)).toBe(FOREIGN);
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
  });
});

describe("recoverCommit — secondary: real commit7Step crash lands in the matrix", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("crash mid step-5 (base promoted, sibling not) → recover completes the commit", async () => {
    await fx.vault.adapter.writeBinary(BASE, enc(OLD_BASE));
    await fx.vault.adapter.writeBinary(SIB, enc(OLD_SIB));
    const meta = await startSession(fx.vault, ID, BASE, SIB, NOW);

    // Crash on the step-5 sibling promote (adapter.rename dst === SIB). Base
    // has already been promoted by then → row H.
    const origGet = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(fx.vault),
      "adapter",
    )!.get!;
    Object.defineProperty(fx.vault, "adapter", {
      configurable: true,
      get() {
        const real = origGet.call(this) as {
          rename: (s: string, d: string) => Promise<void>;
        };
        const rn = real.rename;
        real.rename = async (s: string, d: string) => {
          if (d === SIB) throw new Error("crash step 5 sibling");
          return rn(s, d);
        };
        return real;
      },
    });

    await expect(
      commit7Step(fx.vault, ID, meta, { base: NEW_BASE, sibling: NEW_SIB }, { now: NOW }),
    ).rejects.toThrow(/crash step 5/);

    Object.defineProperty(fx.vault, "adapter", { configurable: true, get: origGet });

    const res = await recoverCommit(fx.vault, ID);
    expect(res).toEqual({ kind: "rolled-forward", siblingRemoved: false });
    await assertCommitted(fx.vault);
  });
});
