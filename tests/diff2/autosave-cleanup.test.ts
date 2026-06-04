// Stage 3c — §4.2 onload cleanup sweep. Node env (real fs over tmpdir);
// composes Stage 2.0 startSession for real sessions, then mutates to trigger
// each cleanup condition.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import { classifySweep, sweepAll } from "../../src/diff2/autosave-cleanup";

const NOW = "2026-06-02T12:00:00.000Z";
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

function fixture() {
  const root = path.join(os.tmpdir(), `cleanup-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

// Start a real session for `id` with distinct input files; base ≠ sibling.
async function seed(vault: Vault, id: string, base = "base v1\n", sib = "sib v1\n") {
  const bp = `b-${id}.md`;
  const sp = `s-${id}.md`;
  await vault.adapter.writeBinary(bp, enc(base));
  await vault.adapter.writeBinary(sp, enc(sib));
  await startSession(vault, id, bp, sp, NOW);
  return { bp, sp };
}

const file = (id: string, name: string) => `${autosaveDir(id)}/${name}`;

describe("classifySweep — §4.2 conditions", () => {
  let fx: ReturnType<typeof fixture>;
  const id = "tracked-c";
  const classify = () => classifySweep(fx.vault, id);

  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("valid session → keep", async () => {
    await seed(fx.vault, id);
    expect(await classify()).toEqual({ action: "keep" });
  });

  it("vault input changed but snapshots intact → keep (NOT a sweep trigger; §3 dialog)", async () => {
    const { bp } = await seed(fx.vault, id);
    await fx.vault.adapter.writeBinary(bp, enc("base v2 — pulled\n")); // input ≠ meta, snapshot unchanged
    expect(await classify()).toEqual({ action: "keep" });
  });

  it("done.json present → defer-to-commit (precedence over §4.2)", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.write(file(id, "done.json"), "{}");
    expect(await classify()).toEqual({ action: "defer-to-commit" });
  });

  it("no meta → sweep", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.remove(file(id, "meta.json"));
    expect(await classify()).toEqual({ action: "sweep", reason: "no-meta" });
  });

  it("no history → sweep", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.remove(file(id, "history.jsonl"));
    expect(await classify()).toEqual({ action: "sweep", reason: "no-history" });
  });

  it("no cursor (NEITHER ping-pong slot) → sweep", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.remove(file(id, "cursor-a.json")); // only slot at start
    expect(await classify()).toEqual({ action: "sweep", reason: "no-cursor" });
  });

  it("only cursor-b present (slot A swept by ping-pong) → keep", async () => {
    await seed(fx.vault, id);
    // simulate a live session that has ping-ponged onto slot B then lost A.
    await fx.vault.adapter.write(
      file(id, "cursor-b.json"),
      JSON.stringify({ v: 1, seq: 1, anchor: 0, head: 0, scrollTop: 0, savedAt: "x" }),
    );
    await fx.vault.adapter.remove(file(id, "cursor-a.json"));
    expect(await classify()).toEqual({ action: "keep" });
  });

  it("missing snapshot → sweep", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.remove(file(id, "sibling.snapshot"));
    expect(await classify()).toEqual({ action: "sweep", reason: "no-snapshot" });
  });

  it("snapshot SHA ≠ meta → sweep (corruption)", async () => {
    await seed(fx.vault, id);
    await fx.vault.adapter.writeBinary(file(id, "base.snapshot"), enc("tampered\n"));
    expect(await classify()).toEqual({ action: "sweep", reason: "snapshot-sha-mismatch" });
  });

  it("input file missing → sweep", async () => {
    const { bp } = await seed(fx.vault, id);
    await fx.vault.adapter.remove(bp);
    expect(await classify()).toEqual({ action: "sweep", reason: "input-missing" });
  });

  it("inputs now byte-identical → sweep (self-resolved)", async () => {
    const { bp, sp } = await seed(fx.vault, id);
    await fx.vault.adapter.writeBinary(bp, enc("MERGED\n"));
    await fx.vault.adapter.writeBinary(sp, enc("MERGED\n"));
    expect(await classify()).toEqual({ action: "sweep", reason: "self-resolved" });
  });
});

describe("sweepAll — list, rmdir condemned, defer commits, keep valid", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => (fx = fixture()));
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("no autosave root → []", async () => {
    expect(await sweepAll(fx.vault)).toEqual([]);
  });

  it("mixed dirs: sweeps invalid, keeps valid, defers commit", async () => {
    await seed(fx.vault, "keep-me"); // valid
    await seed(fx.vault, "no-meta");
    await fx.vault.adapter.remove(file("no-meta", "meta.json"));
    const { bp, sp } = await seed(fx.vault, "resolved");
    await fx.vault.adapter.writeBinary(bp, enc("SAME\n"));
    await fx.vault.adapter.writeBinary(sp, enc("SAME\n"));
    await seed(fx.vault, "committing");
    await fx.vault.adapter.write(file("committing", "done.json"), "{}");

    const results = await sweepAll(fx.vault);
    const byId = new Map(results.map((r) => [r.conflictId, r.decision.action]));
    expect(byId.get("keep-me")).toBe("keep");
    expect(byId.get("no-meta")).toBe("sweep");
    expect(byId.get("resolved")).toBe("sweep");
    expect(byId.get("committing")).toBe("defer-to-commit");

    // Condemned dirs gone; keeper + deferred remain.
    expect(await fx.vault.adapter.exists(autosaveDir("keep-me"))).toBe(true);
    expect(await fx.vault.adapter.exists(autosaveDir("no-meta"))).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir("resolved"))).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir("committing"))).toBe(true);
  });

  it("idempotent: a second sweep keeps the survivors (§4.3)", async () => {
    await seed(fx.vault, "keep-me");
    await seed(fx.vault, "doomed");
    await fx.vault.adapter.remove(file("doomed", "cursor-a.json"));
    await sweepAll(fx.vault);
    const second = await sweepAll(fx.vault);
    expect(second.map((r) => r.conflictId)).toEqual(["keep-me"]);
    expect(second[0].decision.action).toBe("keep");
  });
});
