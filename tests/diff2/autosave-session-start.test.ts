// Stage 2.0 — session-start protocol + reopen detection
// (DIFF-EDITOR.md §2.5.a / §2.5.b).
//
// Node env (real fs over a tmpdir via mock-obsidian Vault), NOT happy-dom:
// this exercises the vault adapter, not the DOM.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../../src/utils";
import { build } from "../../src/diff2/joined-doc";
import {
  AUTOSAVE_ROOT,
  autosaveDir,
  classifyReopen,
  readMeta,
  startSession,
  type AutosaveMeta,
} from "../../src/diff2/autosave-store";

const NOW = "2026-06-02T12:00:00.000Z";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `autosave-session-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("startSession — §2.5.a", () => {
  let fx: ReturnType<typeof fixture>;
  const id = "tracked-abc";

  beforeEach(async () => {
    fx = fixture();
    await fx.vault.adapter.writeBinary("base.md", enc("base content\n"));
    await fx.vault.adapter.writeBinary("sibling.md", enc("sibling content\n"));
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("writes all five files and returns the meta", async () => {
    const meta = await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    const dir = autosaveDir(id);
    for (const f of ["meta.json", "base.snapshot", "sibling.snapshot", "cursor.json", "history.jsonl"]) {
      expect(await fx.vault.adapter.exists(`${dir}/${f}`)).toBe(true);
    }
    expect(meta.conflictId).toBe(id);
    expect(meta.v).toBe(1);
    expect(meta.createdAt).toBe(NOW);
    // joinedDocSha = SHA(build(base, sibling)) — the replay-validity fingerprint.
    expect(meta.joinedDocSha).toBe(
      await calculateGitBlobSHA(enc(build("base content\n", "sibling content\n"))),
    );
  });

  it("snapshots are byte-exact copies and meta SHAs match them", async () => {
    const meta = await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    const dir = autosaveDir(id);

    const baseSnap = await fx.vault.adapter.readBinary(`${dir}/base.snapshot`);
    const sibSnap = await fx.vault.adapter.readBinary(`${dir}/sibling.snapshot`);
    expect(Buffer.from(baseSnap).toString()).toBe("base content\n");
    expect(Buffer.from(sibSnap).toString()).toBe("sibling content\n");

    // The strong invariant: meta's SHAs are the snapshot bytes' SHAs.
    expect(meta.baseShaAtStart).toBe(await calculateGitBlobSHA(baseSnap));
    expect(meta.siblingShaAtStart).toBe(await calculateGitBlobSHA(sibSnap));
  });

  it("cursor.json initialises to (0,0,0); history.jsonl is empty", async () => {
    await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    const dir = autosaveDir(id);

    const cursor = JSON.parse(await fx.vault.adapter.read(`${dir}/cursor.json`));
    expect(cursor).toMatchObject({ v: 1, anchor: 0, head: 0, scrollTop: 0, savedAt: NOW });

    const history = await fx.vault.adapter.readBinary(`${dir}/history.jsonl`);
    expect(history.byteLength).toBe(0);
  });

  it("meta.json round-trips through readMeta", async () => {
    const written = await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    const read = await readMeta(fx.vault, id);
    expect(read).toEqual<AutosaveMeta>(written);
  });

  it("is idempotent on a pre-existing dir (reopen overwrites cleanly)", async () => {
    await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    // Second call must not throw on the already-existing dir.
    const meta = await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    expect(meta.conflictId).toBe(id);
    expect(await fx.vault.adapter.exists(`${AUTOSAVE_ROOT}/${id}/meta.json`)).toBe(true);
  });
});

describe("classifyReopen — §3.1 detection (joinedDocSha gate)", () => {
  let fx: ReturnType<typeof fixture>;
  const id = "tracked-xyz";
  const reopen = () => classifyReopen(fx.vault, id, "base.md", "sibling.md");

  beforeEach(async () => {
    fx = fixture();
    await fx.vault.adapter.writeBinary("base.md", enc("base v1\n"));
    await fx.vault.adapter.writeBinary("sibling.md", enc("sib v1\n"));
  });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it("no meta → fresh", async () => {
    expect((await reopen()).kind).toBe("fresh");
  });

  it("vault unchanged → resume", async () => {
    const meta = await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    const status = await reopen();
    expect(status.kind).toBe("resume");
    if (status.kind === "resume") expect(status.meta).toEqual(meta);
  });

  it("input changed (joined differs) → vault-changed with current SHAs", async () => {
    await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    await fx.vault.adapter.writeBinary("base.md", enc("base v2 — pulled\n"));
    const status = await reopen();
    expect(status.kind).toBe("vault-changed");
    if (status.kind === "vault-changed") {
      expect(status.currentBaseSha).toBe(await calculateGitBlobSHA(enc("base v2 — pulled\n")));
      expect(status.currentBaseSha).not.toBe(status.meta.baseShaAtStart);
      expect(status.currentSiblingSha).toBe(status.meta.siblingShaAtStart);
    }
  });

  it("inputs SAME but joinedDocSha differs (library drift) → library-drift", async () => {
    await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    // Simulate a different diff-library output for identical inputs by tampering
    // meta.joinedDocSha while leaving base/sibling untouched.
    const meta = (await readMeta(fx.vault, id))!;
    await fx.vault.adapter.write(
      `${autosaveDir(id)}/meta.json`,
      JSON.stringify({ ...meta, joinedDocSha: "deadbeef".padEnd(40, "0") }),
    );
    expect((await reopen()).kind).toBe("library-drift");
  });

  it("a \\0 sentinel entered an input since start → sentinel (route to §1.3)", async () => {
    await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    await fx.vault.adapter.writeBinary("base.md", enc("base\0poisoned\n"));
    expect((await reopen()).kind).toBe("sentinel");
  });

  it("snapshot integrity failure → corrupt", async () => {
    await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    await fx.vault.adapter.writeBinary(`${autosaveDir(id)}/base.snapshot`, enc("tampered\n"));
    const status = await reopen();
    expect(status.kind).toBe("corrupt");
    if (status.kind === "corrupt") expect(status.reason).toBe("snapshot-integrity");
  });

  it("input file removed since start → corrupt (input-missing)", async () => {
    await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    await fx.vault.adapter.remove("base.md");
    const status = await reopen();
    expect(status.kind).toBe("corrupt");
    if (status.kind === "corrupt") expect(status.reason).toBe("input-missing");
  });

  it("corrupt meta.json → fresh (readMeta degrades to null)", async () => {
    await startSession(fx.vault, id, "base.md", "sibling.md", NOW);
    await fx.vault.adapter.write(`${autosaveDir(id)}/meta.json`, "{ not json");
    expect((await reopen()).kind).toBe("fresh");
  });
});
