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
import PushQueue from "../../src/sync2/push-queue";
import TreeBuilder, {
  TreeBuilderClient,
} from "../../src/sync2/tree-builder";
import { Vault, arrayBufferToBase64 } from "../../mock-obsidian";
import { FileChange } from "../../src/sync2/types";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fakeClient(): TreeBuilderClient & {
  calls: { content: string; encoding?: string }[];
  shaFor: (content: string) => string;
} {
  const calls: { content: string; encoding?: string }[] = [];
  return {
    calls,
    shaFor: (content: string) =>
      "sha-" + crypto.createHash("sha1").update(content).digest("hex").slice(0, 8),
    createBlob: async ({ content, encoding }) => {
      calls.push({ content, encoding });
      const sha =
        "sha-" +
        crypto.createHash("sha1").update(content).digest("hex").slice(0, 8);
      return { sha };
    },
  };
}

function fixture(): {
  root: string;
  vault: Vault;
  queue: PushQueue;
  client: ReturnType<typeof fakeClient>;
  builder: TreeBuilder;
} {
  const root = path.join(
    os.tmpdir(),
    `tree-builder-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const queue = new PushQueue({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const client = fakeClient();
  const builder = new TreeBuilder({
    vault: vault as unknown as import("obsidian").Vault,
    queue,
    client,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  return { root, vault, queue, client, builder };
}

function writeVaultFile(
  root: string,
  rel: string,
  content: string | Buffer,
): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const ADD = (p: string): FileChange => ({
  kind: "added",
  path: p,
  size: 0,
  mtime: 0,
});
const DEL = (p: string): FileChange => ({
  kind: "deleted",
  path: p,
  previousRemoteSha: "old",
});

describe("TreeBuilder", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("inlines content for text files; no createBlob call", async () => {
    writeVaultFile(f.root, "Notes/x.md", "hello\n");
    const id = await f.queue.enqueue([ADD("Notes/x.md")], {
      commitMessage: "msg",
      parentCommitSha: "p1",
      parentTreeSha: "t1",
    });

    const { entries, baseTreeSha } = await f.builder.buildTreeEntries(id);
    expect(baseTreeSha).toBe("t1");
    expect(entries).toEqual([
      { path: "Notes/x.md", mode: "100644", type: "blob", content: "hello\n" },
    ]);
    expect(f.client.calls).toEqual([]);
  });

  it("uploads binary as base64 via createBlob and uses its SHA", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    writeVaultFile(f.root, "img.png", bytes);
    const id = await f.queue.enqueue([ADD("img.png")], {
      commitMessage: "msg",
      parentCommitSha: null,
      parentTreeSha: null,
    });

    const { entries } = await f.builder.buildTreeEntries(id);

    expect(f.client.calls).toHaveLength(1);
    expect(f.client.calls[0].encoding).toBe("base64");
    const expectedB64 = arrayBufferToBase64(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    expect(f.client.calls[0].content).toBe(expectedB64);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: "img.png",
      mode: "100644",
      type: "blob",
    });
    expect(entries[0].sha).toBe(f.client.shaFor(expectedB64));
    expect(entries[0].content).toBeUndefined();
  });

  it("emits deletions as { sha: null }", async () => {
    const id = await f.queue.enqueue([DEL("Folder/old.md")], {
      commitMessage: "rm",
      parentCommitSha: null,
      parentTreeSha: null,
    });
    const { entries } = await f.builder.buildTreeEntries(id);
    expect(entries).toEqual([
      { path: "Folder/old.md", mode: "100644", type: "blob", sha: null },
    ]);
    expect(f.client.calls).toEqual([]);
  });

  it("handles a mixed batch: text + binary + deletion", async () => {
    writeVaultFile(f.root, "Notes/x.md", "v1\n");
    const bytes = Buffer.from([1, 2, 3, 4]);
    writeVaultFile(f.root, "img.png", bytes);
    const id = await f.queue.enqueue(
      [ADD("Notes/x.md"), ADD("img.png"), DEL("Folder/old.md")],
      {
        commitMessage: "mix",
        parentCommitSha: "p",
        parentTreeSha: "t",
      },
    );

    const { entries, baseTreeSha } = await f.builder.buildTreeEntries(id);
    expect(baseTreeSha).toBe("t");
    expect(f.client.calls).toHaveLength(1);

    const byPath = new Map(entries.map((e) => [e.path, e]));
    const text = byPath.get("Notes/x.md")!;
    expect(text.content).toBe("v1\n");
    expect(text.sha).toBeUndefined();
    expect(byPath.get("img.png")?.sha).toMatch(/^sha-/);
    expect(byPath.get("Folder/old.md")).toMatchObject({ sha: null });
  });

  it("reads from the batch's vault/ snapshot, not the live vault", async () => {
    writeVaultFile(f.root, "Notes/x.md", "v1-snapshot-time\n");
    const id = await f.queue.enqueue([ADD("Notes/x.md")], {
      commitMessage: "msg",
      parentCommitSha: null,
      parentTreeSha: null,
    });

    // After enqueue, simulate the user editing further. The batch
    // must still ship the snapshot taken at enqueue time.
    writeVaultFile(f.root, "Notes/x.md", "v2-after-snapshot\n");

    const { entries } = await f.builder.buildTreeEntries(id);
    expect(entries[0].content).toBe("v1-snapshot-time\n");
  });

  it("base_tree is null when batch was enqueued from a fresh state", async () => {
    writeVaultFile(f.root, "x.md", "first");
    const id = await f.queue.enqueue([ADD("x.md")], {
      commitMessage: "first",
      parentCommitSha: null,
      parentTreeSha: null,
    });
    const { baseTreeSha } = await f.builder.buildTreeEntries(id);
    expect(baseTreeSha).toBeNull();
  });

  it("empty batch (no files, no deletions) returns no entries", async () => {
    const id = await f.queue.enqueue([], {
      commitMessage: "empty",
      parentCommitSha: "p",
      parentTreeSha: "t",
    });
    const { entries } = await f.builder.buildTreeEntries(id);
    expect(entries).toEqual([]);
    expect(f.client.calls).toEqual([]);
  });

  it("uploads multiple binaries in parallel", async () => {
    writeVaultFile(f.root, "a.png", Buffer.from([1]));
    writeVaultFile(f.root, "b.png", Buffer.from([2]));
    writeVaultFile(f.root, "c.png", Buffer.from([3]));
    const id = await f.queue.enqueue(
      [ADD("a.png"), ADD("b.png"), ADD("c.png")],
      {
        commitMessage: "imgs",
        parentCommitSha: null,
        parentTreeSha: null,
      },
    );

    const { entries } = await f.builder.buildTreeEntries(id);
    expect(entries).toHaveLength(3);
    expect(f.client.calls).toHaveLength(3);
    // SHAs must be unique per content.
    const shas = entries.map((e) => e.sha);
    expect(new Set(shas).size).toBe(3);
  });

  it("returns the original batch unchanged for the caller's bookkeeping", async () => {
    writeVaultFile(f.root, "x.md", "v");
    const id = await f.queue.enqueue([ADD("x.md")], {
      commitMessage: "label",
      parentCommitSha: "abc",
      parentTreeSha: "def",
    });
    const { batch } = await f.builder.buildTreeEntries(id);
    expect(batch.id).toBe(id);
    expect(batch.commitMessage).toBe("label");
    expect(batch.parentCommitSha).toBe("abc");
    expect(batch.parentTreeSha).toBe("def");
  });
});
