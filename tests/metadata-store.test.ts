import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import MetadataStore, { MANIFEST_FILE_NAME } from "../src/metadata-store";
import { Vault } from "../mock-obsidian";

const CONFIG_DIR = ".obsidian";

function makeTempVaultRoot(): string {
  const dir = path.join(
    os.tmpdir(),
    `metadata-store-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("MetadataStore.load()", () => {
  let vaultRoot: string;
  let vault: Vault;
  let manifestPath: string;
  let store: MetadataStore;

  beforeEach(() => {
    vaultRoot = makeTempVaultRoot();
    vault = new Vault(vaultRoot);
    manifestPath = `${CONFIG_DIR}/${MANIFEST_FILE_NAME}`;
    // The mock vault casts loosely; the store only uses adapter and configDir
    // so this is enough.
    store = new MetadataStore(vault as unknown as import("obsidian").Vault);
  });

  it("creates an empty Metadata when file doesn't exist (with manifest entry)", async () => {
    await store.load();
    expect(store.data.lastSync).toBe(0);
    expect(store.data.firstSyncFromRemoteInProgress).toBe(false);
    // Manifest entry is auto-inserted by the new invariant.
    expect(store.data.files[manifestPath]).toBeDefined();
    expect(store.data.files[manifestPath].sha).toBe(null);
    expect(store.data.files[manifestPath].path).toBe(manifestPath);
  });

  it("loads existing metadata and adds manifest entry if missing", async () => {
    // Hand-craft a metadata file that's missing the manifest entry —
    // the kind of stale state that used to crash commitSync with a
    // TypeError.
    const stale = {
      lastSync: 12345,
      files: {
        "Notes/foo.md": {
          path: "Notes/foo.md",
          sha: "abc",
          dirty: false,
          justDownloaded: false,
          lastModified: 0,
        },
      },
    };
    fs.mkdirSync(path.join(vaultRoot, CONFIG_DIR), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, manifestPath),
      JSON.stringify(stale),
    );

    await store.load();

    // Existing entry stays.
    expect(store.data.files["Notes/foo.md"]).toBeDefined();
    expect(store.data.files["Notes/foo.md"].sha).toBe("abc");
    // Manifest entry is now present.
    expect(store.data.files[manifestPath]).toBeDefined();
    expect(store.data.files[manifestPath].path).toBe(manifestPath);
  });

  it("preserves existing manifest entry instead of overwriting it", async () => {
    const stale = {
      lastSync: 100,
      files: {
        [`${CONFIG_DIR}/${MANIFEST_FILE_NAME}`]: {
          path: `${CONFIG_DIR}/${MANIFEST_FILE_NAME}`,
          sha: "preserved",
          dirty: true,
          justDownloaded: false,
          lastModified: 999,
        },
      },
    };
    fs.mkdirSync(path.join(vaultRoot, CONFIG_DIR), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, manifestPath),
      JSON.stringify(stale),
    );

    await store.load();

    expect(store.data.files[manifestPath].sha).toBe("preserved");
    expect(store.data.files[manifestPath].lastModified).toBe(999);
  });

  it("recovers from missing files map", async () => {
    fs.mkdirSync(path.join(vaultRoot, CONFIG_DIR), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, manifestPath),
      JSON.stringify({ lastSync: 1 }),
    );

    await store.load();

    expect(store.data.files).toBeDefined();
    expect(store.data.files[manifestPath]).toBeDefined();
  });
});
