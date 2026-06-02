// Stage 2.1 — the 7-step `[← back]` commit + TOCTOU detector
// (DIFF-EDITOR.md §5.0 / §5.0 Step 1.5 / §5.0.e save-to-alt).
//
// Composes Stage 2.0 (startSession creates the real meta + dir) with Stage
// 2.1 commit7Step, so the meta contract is exercised, not faked. Node env
// (real fs over tmpdir), with the commit happy-path also run under
// MOCK_PLATFORM=mobile to pin Capacitor rename semantics (CLAUDE.md rule:
// any new write-then-rename path owes a mobile-paired test).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault, setMockPlatform } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../../src/utils";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import {
  classifyToctou,
  commit7Step,
  type DoneJson,
} from "../../src/diff2/exit-commit";

const NOW = "2026-06-02T12:00:00.000Z";
const ID = "tracked-commit";
const BASE = "Notes/meeting.md";
const SIB = "Notes/meeting.conflict-from-Phone-X.md";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function fixture() {
  const root = path.join(os.tmpdir(), `exit-commit-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

async function seedConflict(vault: Vault, base: string, sibling: string) {
  await vault.adapter.writeBinary(BASE, enc(base));
  await vault.adapter.writeBinary(SIB, enc(sibling));
  return startSession(vault, ID, BASE, SIB, NOW);
}

describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
  "commit7Step happy path (under $platform)",
  ({ platform }) => {
    let fx: ReturnType<typeof fixture>;
    beforeEach(() => {
      setMockPlatform(platform);
      fx = fixture();
    });
    afterEach(() => {
      setMockPlatform("desktop");
      fs.rmSync(fx.root, { recursive: true, force: true });
    });

    it("writes BOTH sides, removes done.json + staging + dir; differing sides keep the sibling", async () => {
      const meta = await seedConflict(fx.vault, "OLD base\n", "OLD sibling\n");
      const res = await commit7Step(
        fx.vault,
        ID,
        meta,
        { base: "RESOLVED base\n", sibling: "RESOLVED sibling\n" },
        { now: NOW },
      );

      expect(await fx.vault.adapter.read(BASE)).toBe("RESOLVED base\n");
      expect(await fx.vault.adapter.read(SIB)).toBe("RESOLVED sibling\n");
      expect(res.siblingRemoved).toBe(false);

      // No leftover staging / barrier / session dir.
      for (const p of [
        `${BASE}.sync-tmp.md`,
        `${BASE}.sync-bak.md`,
        `${SIB}.sync-tmp.md`,
        `${SIB}.sync-bak.md`,
      ]) {
        expect(await fx.vault.adapter.exists(p)).toBe(false);
      }
      expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
    });

    it("identical resolved sides → step 6.5 removes the redundant sibling", async () => {
      const meta = await seedConflict(fx.vault, "OLD base\n", "OLD sibling\n");
      const res = await commit7Step(
        fx.vault,
        ID,
        meta,
        { base: "MERGED\n", sibling: "MERGED\n" },
        { now: NOW },
      );
      expect(res.siblingRemoved).toBe(true);
      expect(await fx.vault.adapter.read(BASE)).toBe("MERGED\n");
      expect(await fx.vault.adapter.exists(SIB)).toBe(false);
      expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
    });
  },
);

describe("commit7Step — done.json hash consistency + save-to-alt", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => {
    setMockPlatform("desktop");
    fx = fixture();
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("done.json expected SHAs hash the exact committed bytes", async () => {
    // Capture done.json by crashing step 3's writeBinary (after step 2 wrote it).
    const meta = await seedConflict(fx.vault, "old\n", "old\n");
    const orig = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(fx.vault),
      "adapter",
    )!.get!;
    Object.defineProperty(fx.vault, "adapter", {
      configurable: true,
      get() {
        const real = orig.call(this) as {
          writeBinary: (p: string, b: ArrayBuffer) => Promise<void>;
        };
        const wb = real.writeBinary;
        real.writeBinary = async (p: string, b: ArrayBuffer) => {
          // Only the step-3 base/sibling staging (.md); NOT done.json's own
          // atomicWriteFile staging (.sync-tmp.json), which must complete first.
          if (p.includes(".sync-tmp.md")) throw new Error("crash step 3");
          return wb(p, b);
        };
        return real;
      },
    });

    await expect(
      commit7Step(fx.vault, ID, meta, { base: "B-bytes\n", sibling: "S-bytes\n" }, { now: NOW }),
    ).rejects.toThrow(/crash step 3/);

    Object.defineProperty(fx.vault, "adapter", { configurable: true, get: orig });
    const done = JSON.parse(
      await fx.vault.adapter.read(`${autosaveDir(ID)}/done.json`),
    ) as DoneJson;
    expect(done.v).toBe(1);
    expect(done.expectedBaseSha).toBe(await calculateGitBlobSHA(enc("B-bytes\n")));
    expect(done.expectedSiblingSha).toBe(await calculateGitBlobSHA(enc("S-bytes\n")));
  });

  it("save-to-alt: writes fresh alt paths, leaves originals untouched, skips step 6.5", async () => {
    const meta = await seedConflict(fx.vault, "GitHub-pulled base\n", "current sibling\n");
    const altBase = "Notes/meeting.diff2-stale-1716987131.md";
    const altSib = "Notes/meeting.conflict-from-Phone-X.diff2-stale-1716987131.md";

    const res = await commit7Step(
      fx.vault,
      ID,
      meta,
      { base: "MERGED\n", sibling: "MERGED\n" }, // identical, but alt → 6.5 must NOT fire
      { now: NOW, targetBasePath: altBase, targetSiblingPath: altSib },
    );

    expect(res.siblingRemoved).toBe(false); // 6.5 gated on target===meta.siblingPath
    expect(await fx.vault.adapter.read(altBase)).toBe("MERGED\n");
    expect(await fx.vault.adapter.read(altSib)).toBe("MERGED\n");
    // Originals untouched (the externally-changed content survives).
    expect(await fx.vault.adapter.read(BASE)).toBe("GitHub-pulled base\n");
    expect(await fx.vault.adapter.read(SIB)).toBe("current sibling\n");
    expect(await fx.vault.adapter.exists(autosaveDir(ID))).toBe(false);
  });
});

describe("classifyToctou — §5.0 Step 1.5 detection", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => {
    setMockPlatform("desktop");
    fx = fixture();
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("unchanged vault → ok", async () => {
    const meta = await seedConflict(fx.vault, "b\n", "s\n");
    expect((await classifyToctou(fx.vault, meta)).kind).toBe("ok");
  });

  it("base changed externally → mismatch with flags + current SHAs", async () => {
    const meta = await seedConflict(fx.vault, "b\n", "s\n");
    await fx.vault.adapter.writeBinary(BASE, enc("b-pulled\n"));
    const st = await classifyToctou(fx.vault, meta);
    expect(st.kind).toBe("mismatch");
    if (st.kind === "mismatch") {
      expect(st.baseChanged).toBe(true);
      expect(st.siblingChanged).toBe(false);
      expect(st.currentBaseSha).toBe(await calculateGitBlobSHA(enc("b-pulled\n")));
    }
  });
});
