import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import {
  executeExitProtocol,
  findSiblingPaths,
} from "../../src/diff2/exit-protocol";
import { buildSiblingPath } from "../../src/sync2/conflict-store";

// Phase 4 unit tests — proactive sibling cleanup on `[←]` exit
// (R7.11). Verifies SHA-compare logic, multi-sibling Scenario C,
// idempotence, config-dir reach via adapter.list.

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `exit-protocol-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  const vault = new Vault(root);
  return { root, vault };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function existsInVault(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

function siblingPathFor(
  vaultPath: string,
  device: string,
  whenMs: number,
): string {
  return buildSiblingPath(vaultPath, device, whenMs, "modify-vs-modify");
}

describe("findSiblingPaths", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(() => {
    fx = fixture();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("returns empty when directory has no siblings of basePath", async () => {
    writeFile(fx.root, "note.md", "x");
    writeFile(fx.root, "other.md", "y");
    const result = await findSiblingPaths(
      fx.vault as unknown as import("obsidian").Vault,
      "note.md",
    );
    expect(result).toEqual([]);
  });

  it("finds vault-root sibling", async () => {
    writeFile(fx.root, "note.md", "x");
    const sib = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26));
    writeFile(fx.root, sib, "y");

    const result = await findSiblingPaths(
      fx.vault as unknown as import("obsidian").Vault,
      "note.md",
    );
    expect(result).toEqual([sib]);
  });

  it("finds nested-folder sibling", async () => {
    writeFile(fx.root, "Folder/Sub/note.md", "x");
    const sib = siblingPathFor(
      "Folder/Sub/note.md",
      "Phone",
      Date.UTC(2026, 4, 26),
    );
    writeFile(fx.root, sib, "y");

    const result = await findSiblingPaths(
      fx.vault as unknown as import("obsidian").Vault,
      "Folder/Sub/note.md",
    );
    expect(result).toEqual([sib]);
  });

  it("finds .obsidian/* config-dir sibling (where vault.getFiles would miss it)", async () => {
    // CONFIRMS the R7.11 motivation for adapter.list over vault.getFiles:
    // dotfile paths inside .obsidian/ are not in the regular file index.
    writeFile(fx.root, ".obsidian/plugins/foo/data.json", "{}");
    const sib = siblingPathFor(
      ".obsidian/plugins/foo/data.json",
      "Phone",
      Date.UTC(2026, 4, 26),
    );
    writeFile(fx.root, sib, "{}");

    const result = await findSiblingPaths(
      fx.vault as unknown as import("obsidian").Vault,
      ".obsidian/plugins/foo/data.json",
    );
    expect(result).toEqual([sib]);
  });

  it("returns empty when basePath's directory doesn't exist", async () => {
    const result = await findSiblingPaths(
      fx.vault as unknown as import("obsidian").Vault,
      "Missing/dir/file.md",
    );
    expect(result).toEqual([]);
  });

  it("returns multiple siblings for the same base (multi-sibling Scenario C)", async () => {
    writeFile(fx.root, "note.md", "x");
    const sib1 = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26, 10));
    const sib2 = siblingPathFor("note.md", "Laptop", Date.UTC(2026, 4, 26, 11));
    writeFile(fx.root, sib1, "phone bytes");
    writeFile(fx.root, sib2, "laptop bytes");

    const result = await findSiblingPaths(
      fx.vault as unknown as import("obsidian").Vault,
      "note.md",
    );
    expect(result.sort()).toEqual([sib1, sib2].sort());
  });

  it("ignores non-sibling files in the same directory", async () => {
    writeFile(fx.root, "note.md", "x");
    writeFile(fx.root, "note.bak.md", "y"); // not a sibling pattern
    writeFile(fx.root, "other.conflict-from-X-Y.md", "z"); // sibling of a different base

    const result = await findSiblingPaths(
      fx.vault as unknown as import("obsidian").Vault,
      "note.md",
    );
    expect(result).toEqual([]);
  });
});

describe("executeExitProtocol", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(() => {
    fx = fixture();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("step 1: writes resolved bytes to base file via atomicWriteFile", async () => {
    writeFile(fx.root, "note.md", "before");

    await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      "note.md",
      "after",
    );

    expect(fs.readFileSync(path.join(fx.root, "note.md"), "utf8")).toBe(
      "after",
    );
  });

  it("step 2: removes sibling whose SHA matches base", async () => {
    writeFile(fx.root, "note.md", "before");
    const sib = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26));
    // Sibling content = the resolved text → SHA will match post-write.
    writeFile(fx.root, sib, "resolved");

    const result = await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      "note.md",
      "resolved",
    );

    expect(result.siblingsRemoved).toEqual([sib]);
    expect(existsInVault(fx.root, sib)).toBe(false);
    expect(fs.readFileSync(path.join(fx.root, "note.md"), "utf8")).toBe(
      "resolved",
    );
  });

  it("step 2: leaves sibling whose SHA differs from base", async () => {
    writeFile(fx.root, "note.md", "before");
    const sib = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26));
    writeFile(fx.root, sib, "different bytes");

    const result = await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      "note.md",
      "resolved",
    );

    expect(result.siblingsRemoved).toEqual([]);
    expect(existsInVault(fx.root, sib)).toBe(true);
  });

  it("multi-sibling Scenario C: removes only the SHA-matching sibling", async () => {
    writeFile(fx.root, "note.md", "before");
    const sib1 = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26, 10));
    const sib2 = siblingPathFor(
      "note.md",
      "Laptop",
      Date.UTC(2026, 4, 26, 11),
    );
    writeFile(fx.root, sib1, "phone-bytes");
    writeFile(fx.root, sib2, "laptop-bytes"); // user resolves to this

    const result = await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      "note.md",
      "laptop-bytes",
    );

    expect(result.siblingsRemoved).toEqual([sib2]);
    expect(existsInVault(fx.root, sib1)).toBe(true);
    expect(existsInVault(fx.root, sib2)).toBe(false);
  });

  it("multi-sibling: removes ALL matching siblings (resolve = both happen to equal)", async () => {
    writeFile(fx.root, "note.md", "before");
    const sib1 = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26, 10));
    const sib2 = siblingPathFor(
      "note.md",
      "Laptop",
      Date.UTC(2026, 4, 26, 11),
    );
    // Both siblings carry identical bytes (rare but possible — e.g.,
    // two devices made the same edit).
    writeFile(fx.root, sib1, "shared-bytes");
    writeFile(fx.root, sib2, "shared-bytes");

    const result = await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      "note.md",
      "shared-bytes",
    );

    expect(result.siblingsRemoved.sort()).toEqual([sib1, sib2].sort());
    expect(existsInVault(fx.root, sib1)).toBe(false);
    expect(existsInVault(fx.root, sib2)).toBe(false);
  });

  it("idempotent: second run after sibling already cleaned is no-op", async () => {
    writeFile(fx.root, "note.md", "before");
    const sib = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26));
    writeFile(fx.root, sib, "resolved");

    // First run: sibling removed.
    await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      "note.md",
      "resolved",
    );

    // Second run: no siblings left to remove.
    const result2 = await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      "note.md",
      "resolved",
    );
    expect(result2.siblingsRemoved).toEqual([]);
    expect(result2.written).toBe(true);
  });

  it("works for `.obsidian/*` config-dir siblings via adapter.list", async () => {
    // R7.11 motivation: vault.delete can't reach .obsidian/* paths,
    // but adapter.remove (used here) covers them.
    writeFile(fx.root, ".obsidian/plugins/foo/data.json", "{}");
    const sib = siblingPathFor(
      ".obsidian/plugins/foo/data.json",
      "Phone",
      Date.UTC(2026, 4, 26),
    );
    writeFile(fx.root, sib, "{\"resolved\": true}");

    const result = await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      ".obsidian/plugins/foo/data.json",
      "{\"resolved\": true}",
    );

    expect(result.siblingsRemoved).toEqual([sib]);
    expect(existsInVault(fx.root, sib)).toBe(false);
  });

  it("returns empty siblingsRemoved when there are no siblings", async () => {
    writeFile(fx.root, "note.md", "before");

    const result = await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      "note.md",
      "after",
    );

    expect(result.written).toBe(true);
    expect(result.siblingsRemoved).toEqual([]);
  });

  it("creates base file if absent (step 1 still runs)", async () => {
    // delete-vs-modify resolution: base was missing, user clicks
    // [apply] on theirs → exit-protocol writes base bytes for the
    // first time.
    expect(existsInVault(fx.root, "note.md")).toBe(false);

    const result = await executeExitProtocol(
      { vault: fx.vault as unknown as import("obsidian").Vault },
      "note.md",
      "first-time-content",
    );

    expect(result.written).toBe(true);
    expect(fs.readFileSync(path.join(fx.root, "note.md"), "utf8")).toBe(
      "first-time-content",
    );
  });
});
