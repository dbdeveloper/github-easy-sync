import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import GitignoreInvariants, {
  INVARIANT_BEGIN,
  INVARIANT_END,
  spliceInvariantBlock,
} from "../../src/sync2/gitignore-invariants";
import SnapshotStore from "../../src/sync2/snapshot-store";
import { Vault } from "../../mock-obsidian";

const CONFIG_DIR = ".obsidian";
const SELF = "github-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `gi-inv-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, CONFIG_DIR, "plugins", SELF), {
    recursive: true,
  });
  const vault = new Vault(root);
  const store = new SnapshotStore(vault as unknown as import("obsidian").Vault);
  const inv = new GitignoreInvariants({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    configDir: CONFIG_DIR,
    selfPluginId: SELF,
  });
  return { root, vault, store, inv };
}

const cdGitignore = (root: string) =>
  path.join(root, CONFIG_DIR, ".gitignore");
const selfGitignore = (root: string) =>
  path.join(root, CONFIG_DIR, "plugins", SELF, ".gitignore");

describe("spliceInvariantBlock (pure)", () => {
  it("replaces an existing block in place", () => {
    const block = `${INVARIANT_BEGIN}\nNEW\n${INVARIANT_END}`;
    const existing = `prefix\n${INVARIANT_BEGIN}\nOLD\n${INVARIANT_END}\nsuffix`;
    expect(spliceInvariantBlock(existing, block)).toBe(
      `prefix\n${block}\nsuffix`,
    );
  });

  it("prepends when markers are missing", () => {
    const block = `${INVARIANT_BEGIN}\nX\n${INVARIANT_END}`;
    expect(spliceInvariantBlock("user content\n", block)).toBe(
      `${block}\n\nuser content\n`,
    );
  });

  it("creates fresh content when input is empty", () => {
    const block = `${INVARIANT_BEGIN}\nY\n${INVARIANT_END}`;
    expect(spliceInvariantBlock("", block)).toBe(`${block}\n`);
  });

  it("leaves user content above and below the block alone", () => {
    const block = `${INVARIANT_BEGIN}\nNEW\n${INVARIANT_END}`;
    const existing = `# header\n\n${INVARIANT_BEGIN}\nOLD\n${INVARIANT_END}\n\n# footer\n*.log\n`;
    const out = spliceInvariantBlock(existing, block);
    expect(out).toContain("# header");
    expect(out).toContain("# footer");
    expect(out).toContain("*.log");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD");
  });
});

describe("GitignoreInvariants.enforce", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(async () => {
    f = fixture();
    await f.store.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("creates configDir/.gitignore with invariant block + recommended defaults when absent", async () => {
    expect(fs.existsSync(cdGitignore(f.root))).toBe(false);
    await f.inv.enforce();
    const content = fs.readFileSync(cdGitignore(f.root), "utf8");
    expect(content).toContain(INVARIANT_BEGIN);
    expect(content).toContain(INVARIANT_END);
    expect(content).toContain("workspace.json");
    expect(content).toContain("Recommended defaults");
    expect(content).toContain("plugins/*/*");
  });

  it("creates self-plugin/.gitignore with canonical allowlist when absent", async () => {
    expect(fs.existsSync(selfGitignore(f.root))).toBe(false);
    await f.inv.enforce();
    const content = fs.readFileSync(selfGitignore(f.root), "utf8");
    expect(content).toContain("*\n");
    expect(content).toContain("!main.js");
    expect(content).toContain("!manifest.json");
    expect(content).toContain("!styles.css");
    expect(content).toContain("!.gitignore");
  });

  it("preserves user content above and below the invariant block on rewrite", async () => {
    const cdPath = cdGitignore(f.root);
    fs.writeFileSync(
      cdPath,
      `# my header\n\n${INVARIANT_BEGIN}\ntampered\n${INVARIANT_END}\n\n# my footer\n*.tmp\n`,
    );
    await f.inv.enforce();
    const content = fs.readFileSync(cdPath, "utf8");
    expect(content).toContain("# my header");
    expect(content).toContain("# my footer");
    expect(content).toContain("*.tmp");
    expect(content).toContain("workspace.json");
    expect(content).not.toContain("tampered");
  });

  it("prepends the invariant block when user file lacks markers", async () => {
    const cdPath = cdGitignore(f.root);
    fs.writeFileSync(cdPath, "*.user-rule\n");
    await f.inv.enforce();
    const content = fs.readFileSync(cdPath, "utf8");
    expect(content).toContain(INVARIANT_BEGIN);
    expect(content).toContain("*.user-rule");
    // Recommended defaults should NOT appear — file existed beforehand.
    expect(content).not.toContain("Recommended defaults");
  });

  it("self-plugin gitignore is fully overwritten regardless of prior content", async () => {
    fs.writeFileSync(selfGitignore(f.root), "completely\nbogus\ncontent\n");
    await f.inv.enforce();
    const content = fs.readFileSync(selfGitignore(f.root), "utf8");
    expect(content).not.toContain("bogus");
    expect(content).toContain("!main.js");
  });

  it("cache hit: second enforce with unchanged mtime makes no writes", async () => {
    await f.inv.enforce();
    const stat1 = fs.statSync(cdGitignore(f.root));

    await new Promise((r) => setTimeout(r, 30));
    await f.inv.enforce();
    const stat2 = fs.statSync(cdGitignore(f.root));
    // mtime should NOT have moved (no rewrite happened).
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it("touched-but-unchanged: refreshes mtime cache without rewriting", async () => {
    await f.inv.enforce();
    const cdPath = cdGitignore(f.root);
    const original = fs.readFileSync(cdPath, "utf8");

    // Bump mtime without changing content.
    fs.utimesSync(cdPath, new Date(), new Date(Date.now() + 5_000));
    await f.inv.enforce();
    expect(fs.readFileSync(cdPath, "utf8")).toBe(original);

    // Cached state now matches new mtime.
    const stat = fs.statSync(cdPath);
    expect(f.store.getInvariantState().configDirGitignore?.mtime).toBe(
      stat.mtimeMs,
    );
  });

  it("real edit: hash mismatch triggers splice rewrite", async () => {
    await f.inv.enforce();
    const cdPath = cdGitignore(f.root);
    // User tampers with the invariant block.
    fs.writeFileSync(
      cdPath,
      `${INVARIANT_BEGIN}\nGOTCHA\n${INVARIANT_END}\n*.user-rule\n`,
    );
    fs.utimesSync(cdPath, new Date(), new Date(Date.now() + 10_000));

    await f.inv.enforce();
    const content = fs.readFileSync(cdPath, "utf8");
    expect(content).not.toContain("GOTCHA");
    expect(content).toContain("workspace.json");
    expect(content).toContain("*.user-rule");
  });

  it("notePathSelfWritten refreshes the cache after a sync2 push", async () => {
    await f.inv.enforce();
    const cdPath = cdGitignore(f.root);

    // Simulate sync2's push ending in a re-write of the file.
    fs.writeFileSync(
      cdPath,
      `${INVARIANT_BEGIN}\n# Per-device state — never propagate between machines.\ngithub-easy-sync-metadata.json\nworkspace.json\nworkspace-mobile.json\ncommunity-plugins.json\n${INVARIANT_END}\n# user added later\n`,
    );
    fs.utimesSync(cdPath, new Date(), new Date(Date.now() + 5_000));

    await f.inv.notePathSelfWritten(`${CONFIG_DIR}/.gitignore`);
    const stat = fs.statSync(cdPath);
    expect(f.store.getInvariantState().configDirGitignore?.mtime).toBe(
      stat.mtimeMs,
    );

    // Next enforce() short-circuits — no rewrite.
    const before = fs.readFileSync(cdPath, "utf8");
    await f.inv.enforce();
    expect(fs.readFileSync(cdPath, "utf8")).toBe(before);
  });

  it("invariant state survives across new instances (persisted in store)", async () => {
    await f.inv.enforce();
    await f.store.save();

    // New instance, fresh load.
    const store2 = new SnapshotStore(
      f.vault as unknown as import("obsidian").Vault,
    );
    await store2.load();
    expect(store2.getInvariantState().configDirGitignore).toBeDefined();
    expect(store2.getInvariantState().selfPluginGitignore).toBeDefined();
  });
});
