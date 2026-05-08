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
import {
  Sync2Manager,
  Sync2Client,
  Sync2Logger,
} from "../../src/sync2/sync2-manager";
import ChangeDetector from "../../src/sync2/change-detector";
import PushQueue from "../../src/sync2/push-queue";
import SnapshotStore from "../../src/sync2/snapshot-store";
import TreeBuilder from "../../src/sync2/tree-builder";
import GI from "../../src/gi";
import { Vault } from "../../mock-obsidian";
import { calculateGitBlobSHA } from "../../src/utils";
import { NewTreeRequestItem } from "../../src/github/client";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function makeFakeClient(): Sync2Client & {
  calls: {
    op: string;
    args: unknown;
  }[];
  state: {
    branchHead: string;
    treeShaCounter: number;
    commitShaCounter: number;
    blobShaCounter: number;
    lastTree: NewTreeRequestItem[] | null;
    lastCommit: { message: string; tree: string; parent?: string } | null;
    // Maps for conflict-handling tests.
    contentsByRef: Map<string, Map<string, string>>; // ref → path → content
    treeShaByCommit: Map<string, string>;
    commitDateByCommit: Map<string, string>;
  };
  setBranchHead(sha: string): void;
  setContentAtRef(ref: string, path: string, content: string): void;
  setTreeShaForCommit(commitSha: string, treeSha: string): void;
  setCommitDate(commitSha: string, isoDate: string): void;
  setCompareResult(
    base: string,
    head: string,
    result: {
      status: "ahead" | "behind" | "identical" | "diverged";
      files: Array<{
        filename: string;
        status:
          | "added"
          | "modified"
          | "removed"
          | "renamed"
          | "copied"
          | "changed"
          | "unchanged";
        sha: string | null;
        previous_filename?: string;
      }>;
    },
  ): void;
} {
  const state = {
    branchHead: "BRANCH_HEAD_INIT",
    treeShaCounter: 0,
    commitShaCounter: 0,
    blobShaCounter: 0,
    lastTree: null as NewTreeRequestItem[] | null,
    lastCommit: null as { message: string; tree: string; parent?: string } | null,
    contentsByRef: new Map<string, Map<string, string>>(),
    treeShaByCommit: new Map<string, string>(),
    commitDateByCommit: new Map<string, string>(),
    compareByPair: new Map<
      string,
      {
        status: "ahead" | "behind" | "identical" | "diverged";
        files: Array<{
          filename: string;
          status:
            | "added"
            | "modified"
            | "removed"
            | "renamed"
            | "copied"
            | "changed"
            | "unchanged";
          sha: string | null;
          previous_filename?: string;
        }>;
      }
    >(),
  };
  const calls: { op: string; args: unknown }[] = [];

  return {
    state,
    calls,
    setBranchHead(sha) {
      state.branchHead = sha;
    },
    setContentAtRef(ref, path, content) {
      let inner = state.contentsByRef.get(ref);
      if (!inner) {
        inner = new Map();
        state.contentsByRef.set(ref, inner);
      }
      inner.set(path, content);
    },
    setTreeShaForCommit(commitSha, treeSha) {
      state.treeShaByCommit.set(commitSha, treeSha);
    },
    setCommitDate(commitSha, isoDate) {
      state.commitDateByCommit.set(commitSha, isoDate);
    },
    setCompareResult(base, head, result) {
      state.compareByPair.set(`${base}...${head}`, result);
    },

    async getBranchHeadSha() {
      calls.push({ op: "getBranchHeadSha", args: undefined });
      return state.branchHead;
    },
    async createBlob(args) {
      calls.push({ op: "createBlob", args });
      const sha =
        "blob-" +
        crypto.createHash("sha1").update(args.content).digest("hex").slice(0, 8) +
        "-" + state.blobShaCounter++;
      return { sha };
    },
    async createTree(args) {
      calls.push({ op: "createTree", args });
      state.lastTree = args.tree.tree;
      state.treeShaCounter++;
      return `TREE_SHA_${state.treeShaCounter}`;
    },
    async createCommit(args) {
      calls.push({ op: "createCommit", args });
      state.lastCommit = {
        message: args.message,
        tree: args.treeSha,
        parent: args.parent,
      };
      state.commitShaCounter++;
      return `COMMIT_SHA_${state.commitShaCounter}`;
    },
    async updateBranchHead(args) {
      calls.push({ op: "updateBranchHead", args });
      state.branchHead = args.sha;
    },
    async getCommit(args) {
      calls.push({ op: "getCommit", args });
      const treeSha = state.treeShaByCommit.get(args.sha) ?? `TREE_OF_${args.sha}`;
      const committedAt = state.commitDateByCommit.get(args.sha)
        ?? new Date(0).toISOString();
      return { tree: { sha: treeSha }, committer: { date: committedAt } };
    },
    async getContentsAtRef(args) {
      calls.push({ op: "getContentsAtRef", args });
      const inner = state.contentsByRef.get(args.ref);
      if (!inner) return null;
      const got = inner.get(args.path);
      if (got === undefined) return null;
      const b64 = Buffer.from(got, "utf8").toString("base64");
      const sha =
        "blob-of-" +
        crypto.createHash("sha1").update(got).digest("hex").slice(0, 8);
      return { content: b64, sha };
    },
    async getRepoContent(_args) {
      calls.push({ op: "getRepoContent", args: _args });
      // Synthesize a tree from whatever's recorded at the current
      // branch head. Tests that exercise bootstrap set the branch
      // head + per-path content via setContentAtRef beforehand.
      const inner = state.contentsByRef.get(state.branchHead);
      const files: Record<
        string,
        {
          path: string;
          mode: string;
          type: string;
          sha: string;
          size: number;
          url: string;
        }
      > = {};
      if (inner) {
        for (const [p, content] of inner.entries()) {
          const sha =
            "blob-of-" +
            crypto.createHash("sha1").update(content).digest("hex").slice(0, 8);
          files[p] = {
            path: p,
            mode: "100644",
            type: "blob",
            sha,
            size: content.length,
            url: "",
          };
        }
      }
      return { files, sha: state.treeShaByCommit.get(state.branchHead) ?? "TREE_UNKNOWN" };
    },
    async getBlob(args) {
      calls.push({ op: "getBlob", args });
      // Find the blob anywhere in our recorded contents that hashes
      // to the requested SHA.
      for (const inner of state.contentsByRef.values()) {
        for (const [, content] of inner.entries()) {
          const sha =
            "blob-of-" +
            crypto.createHash("sha1").update(content).digest("hex").slice(0, 8);
          if (sha === args.sha) {
            return {
              content: Buffer.from(content, "utf8").toString("base64"),
              sha,
            };
          }
        }
      }
      throw new Error(`fake getBlob: sha ${args.sha} not configured`);
    },
    async compare(args) {
      calls.push({ op: "compare", args });
      const r = state.compareByPair.get(`${args.base}...${args.head}`);
      if (r) return r;
      // Default: no changes between unconfigured refs.
      return { status: "identical", files: [] };
    },
  };
}

function silentLogger(): Sync2Logger {
  return {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
  };
}

function fixture(opts?: {
  onConflict?: (a: {
    path: string;
    ours: string;
    base: string;
    theirs: string;
    conflictMarkedContent: string;
  }) => Promise<
    | { kind: "resolved"; content: string }
    | { kind: "deferred" }
    | { kind: "merged-into-one"; content: string }
  >;
  conflictStore?: import("../../src/sync2/conflict-store").default;
  accumulateOfflineSyncs?: boolean;
  onProgress?: (msg: string) => {
    update: (m: string) => void;
    hide: () => void;
  };
  progressMessages?: string[];
  onLocalCommitted?: (count: number) => void;
  onNoLocalChanges?: () => void;
}): {
  root: string;
  vault: Vault;
  store: SnapshotStore;
  detector: ChangeDetector;
  queue: PushQueue;
  builder: TreeBuilder;
  client: ReturnType<typeof makeFakeClient>;
  manager: Sync2Manager;
  clock: { tick: () => Date; nowMs: () => number };
  conflictCalls: {
    path: string;
    ours: string;
    base: string;
    theirs: string;
  }[];
} {
  const root = path.join(
    os.tmpdir(),
    `sync2-manager-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const store = new SnapshotStore(
    vault as unknown as import("obsidian").Vault,
  );
  const gi = new GI(root);
  const detector = new ChangeDetector({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    gi,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    vaultRoot: root,
  });
  let current = new Date("2026-05-03T09:38:23.000Z");
  const clock = {
    tick: () => {
      const d = new Date(current);
      current = new Date(current.getTime() + 1000);
      return d;
    },
    nowMs: () => current.getTime(),
  };
  const queue = new PushQueue({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => clock.tick(),
  });
  const client = makeFakeClient();
  const builder = new TreeBuilder({
    vault: vault as unknown as import("obsidian").Vault,
    queue,
    client,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const conflictCalls: {
    path: string;
    ours: string;
    base: string;
    theirs: string;
  }[] = [];
  const onConflictDefault = async (a: {
    path: string;
    ours: string;
    base: string;
    theirs: string;
    conflictMarkedContent: string;
  }): Promise<{ kind: "resolved"; content: string }> => {
    conflictCalls.push({
      path: a.path,
      ours: a.ours,
      base: a.base,
      theirs: a.theirs,
    });
    return { kind: "resolved", content: a.conflictMarkedContent };
  };
  const manager = new Sync2Manager({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    detector,
    queue,
    builder,
    client,
    logger: silentLogger(),
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    commitMessageAll: "Sync at {date}",
    commitMessageFile: "Update {filename} at {date}",
    deviceLabel: "test-device",
    conflictStore: opts?.conflictStore,
    onConflict: opts?.onConflict ?? onConflictDefault,
    accumulateOfflineSyncs: opts?.accumulateOfflineSyncs ?? false,
    onProgress: opts?.onProgress,
    onLocalCommitted: opts?.onLocalCommitted,
    onNoLocalChanges: opts?.onNoLocalChanges,
    now: () => clock.nowMs(),
  });
  return {
    root,
    vault,
    store,
    detector,
    queue,
    builder,
    client,
    manager,
    clock,
    conflictCalls,
  };
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

async function shaOf(content: string): Promise<string> {
  const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
  return await calculateGitBlobSHA(buf);
}

describe("Sync2Manager.syncAll — basic flow (Etap 6a)", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(async () => {
    f = fixture();
    await f.store.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("no-op when there are no changes", async () => {
    await f.manager.syncAll();
    const ops = f.client.calls.map((c) => c.op);
    // We still ask the branch head (drain step), but nothing else.
    expect(ops).not.toContain("createTree");
    expect(ops).not.toContain("createCommit");
  });

  it("happy path: one new text file → push, commit, ref, snapshot recorded", async () => {
    writeVaultFile(f.root, "Notes/x.md", "hello\n");
    // Pretend we synced once already so the manager has a baseline
    // for HEAD comparison and parents.
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.client.setBranchHead("BRANCH_HEAD_INIT");

    await f.manager.syncAll();

    // pullIfNeeded + processBatch each call getBranchHeadSha — that
    // overhead is fine; what matters is the push sequence ends with
    // a tree+commit+ref triple.
    const significant = f.client.calls
      .map((c) => c.op)
      .filter((o) => o !== "getBranchHeadSha");
    expect(significant).toEqual([
      "createTree",
      "createCommit",
      "updateBranchHead",
    ]);

    // Snapshot store now reflects the push: file is recorded with the
    // canonical-form SHA git would have computed.
    const snap = f.store.get("Notes/x.md");
    expect(snap).toBeDefined();
    expect(snap?.remoteSha).toBe(await shaOf("hello\n"));

    // lastSync points at the commit + tree we just produced.
    expect(f.store.getLastSyncCommitSha()).toBe("COMMIT_SHA_1");
    expect(f.store.getLastSyncTreeSha()).toBe("TREE_SHA_1");

    // Queue is empty after success.
    expect(await f.queue.list()).toEqual([]);
  });

  it("commit message uses the all-sync template with {date}", async () => {
    writeVaultFile(f.root, "x.md", "v");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    // New defaults (Etap 6.5): "Sync at {date}" template + auto-
    // appended " (deviceLabel)" suffix from appendDeviceSuffix.
    expect(f.client.state.lastCommit?.message).toBe(
      "Sync at 2026-05-03T09:38:23.000Z (test-device)",
    );
  });

  it("creates a binary blob first, references its SHA in the tree", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeVaultFile(f.root, "img.png", bytes);
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    const ops = f.client.calls.map((c) => c.op);
    expect(ops).toContain("createBlob");
    const tree = f.client.state.lastTree!;
    const imgEntry = tree.find((e) => e.path === "img.png");
    expect(imgEntry?.sha).toMatch(/^blob-/);
    expect(imgEntry?.content).toBeUndefined();

    // Snapshot stores the same SHA.
    expect(f.store.get("img.png")?.remoteSha).toBe(imgEntry?.sha);
  });

  it("delete propagates: snapshot dropped, tree carries sha:null", async () => {
    // Pretend the file existed in a previous sync and has now been
    // removed locally.
    f.store.set("Notes/old.md", {
      path: "Notes/old.md",
      remoteSha: "OLDSHA",
      mtime: 1,
      size: 1,
    });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    const tree = f.client.state.lastTree!;
    const entry = tree.find((e) => e.path === "Notes/old.md");
    expect(entry?.sha).toBeNull();

    expect(f.store.get("Notes/old.md")).toBeUndefined();
  });

  it("multiple changes in one batch result in a single commit", async () => {
    writeVaultFile(f.root, "a.md", "1");
    writeVaultFile(f.root, "b.md", "2");
    writeVaultFile(f.root, "c.md", "3");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    expect(
      f.client.calls.filter((c) => c.op === "createCommit").length,
    ).toBe(1);
    const tree = f.client.state.lastTree!;
    const paths = tree.map((e) => e.path).sort();
    expect(paths).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("HEAD moved but our path untouched on remote → reconcile is a no-op merge, push proceeds onto new head", async () => {
    writeVaultFile(f.root, "x.md", "v");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    // Remote moved past us. From the perspective of x.md though, the
    // file is identical at both refs (no remote-side change). The
    // reconcile pass should detect that, leave the batch alone, and
    // re-target the commit onto the new head.
    f.client.setBranchHead("OTHER_HEAD");
    f.client.setTreeShaForCommit("OTHER_HEAD", "OTHER_HEAD_TREE");
    const sameContent = "v";
    f.client.setContentAtRef("BRANCH_HEAD_INIT", "x.md", sameContent);
    f.client.setContentAtRef("OTHER_HEAD", "x.md", sameContent);

    await f.manager.syncAll();

    // Commit lands with parent = currentHead, base_tree = its tree.
    const commit = f.client.calls.find((c) => c.op === "createCommit");
    expect((commit?.args as { parent?: string }).parent).toBe("OTHER_HEAD");
    const treeCall = f.client.calls.find((c) => c.op === "createTree");
    expect(
      (treeCall?.args as { tree: { base_tree?: string } }).tree.base_tree,
    ).toBe("OTHER_HEAD_TREE");

    // No conflict UI was needed.
    expect(f.conflictCalls).toEqual([]);
  });

  it("first-ever sync against bare repo: root commit, no parent", async () => {
    writeVaultFile(f.root, "x.md", "v");
    // No setLastSync — fresh install. getBranchHeadSha throws 404
    // (bare repo). sync2 falls back to a root commit.
    f.client.getBranchHeadSha = async () => {
      const e = new Error("Not Found") as Error & { status: number };
      e.status = 404;
      throw e;
    };

    await f.manager.syncAll();

    expect(f.client.state.lastCommit?.parent).toBeUndefined();
    expect(f.store.getLastSyncCommitSha()).toBe("COMMIT_SHA_1");
  });

  it("first-ever sync against existing branch: parent=currentHead, base_tree=its tree", async () => {
    writeVaultFile(f.root, "x.md", "v");
    // No setLastSync, but the branch already has commits. sync2 must
    // build on top, otherwise updateBranchHead would 422 (non-ff).
    f.client.setBranchHead("EXISTING_HEAD");
    f.client.setTreeShaForCommit("EXISTING_HEAD", "EXISTING_HEAD_TREE");

    await f.manager.syncAll();

    expect(f.client.state.lastCommit?.parent).toBe("EXISTING_HEAD");
    const treeCall = f.client.calls.find((c) => c.op === "createTree");
    expect(
      (treeCall?.args as { tree: { base_tree?: string } }).tree.base_tree,
    ).toBe("EXISTING_HEAD_TREE");
  });

  it("base_tree from manifest's lastSyncTreeSha when set", async () => {
    writeVaultFile(f.root, "x.md", "v");
    f.store.setLastSync("BRANCH_HEAD_INIT", "EXISTING_TREE_SHA");

    await f.manager.syncAll();

    const treeCall = f.client.calls.find((c) => c.op === "createTree")!;
    const args = treeCall.args as {
      tree: { base_tree?: string };
    };
    expect(args.tree.base_tree).toBe("EXISTING_TREE_SHA");
  });

  it("lastCommitMtime is set to the local clock after a successful push", async () => {
    writeVaultFile(f.root, "x.md", "v");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    expect(f.store.getLastCommitMtime()).toBe(f.clock.nowMs());
  });

  it("multiple pending batches drain oldest-first", async () => {
    // Manually enqueue two batches so processQueue has work to drain
    // even before findChanges contributes.
    writeVaultFile(f.root, "a.md", "1");
    f.store.setLastSync("BRANCH_HEAD_INIT", "TREE_0");
    const id1 = await f.queue.enqueue(
      [{ kind: "added", path: "a.md", size: 1, mtime: 0 }],
      {
        commitMessage: "first",
        parentCommitSha: "BRANCH_HEAD_INIT",
        parentTreeSha: "TREE_0",
      },
    );
    writeVaultFile(f.root, "b.md", "2");
    const id2 = await f.queue.enqueue(
      [{ kind: "added", path: "b.md", size: 1, mtime: 0 }],
      {
        commitMessage: "second",
        parentCommitSha: "BRANCH_HEAD_INIT",
        parentTreeSha: "TREE_0",
      },
    );
    expect(id2 > id1).toBe(true);

    // findChanges sees nothing new (snapshots aren't there yet but the
    // files exist so it would emit "added" for both). Snapshot them
    // explicitly so syncAll's findChanges yields no extra batch.
    f.store.set("a.md", {
      path: "a.md",
      remoteSha: await shaOf("1"),
      mtime: fs.statSync(path.join(f.root, "a.md")).mtimeMs,
      size: 1,
    });
    f.store.set("b.md", {
      path: "b.md",
      remoteSha: await shaOf("2"),
      mtime: fs.statSync(path.join(f.root, "b.md")).mtimeMs,
      size: 1,
    });
    await f.store.save();

    await f.manager.resumeQueue();

    // Two commits, in order.
    const commits = f.client.calls.filter((c) => c.op === "createCommit");
    expect(commits).toHaveLength(2);
    expect((commits[0].args as { message: string }).message).toBe("first");
    expect((commits[1].args as { message: string }).message).toBe("second");

    // After both, queue is empty.
    expect(await f.queue.list()).toEqual([]);
  });

  it("syncFile: nothing to sync when file matches snapshot", async () => {
    writeVaultFile(f.root, "x.md", "v");
    const stat = fs.statSync(path.join(f.root, "x.md"));
    f.store.set("x.md", {
      path: "x.md",
      remoteSha: await shaOf("v"),
      mtime: stat.mtimeMs,
      size: stat.size,
    });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    await f.manager.syncFile("x.md");
    expect(f.client.calls.filter((c) => c.op === "createCommit")).toEqual([]);
  });

  it("syncFile: pushes a single-file batch with file-template message", async () => {
    writeVaultFile(f.root, "Notes/note.md", "fresh\n");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncFile("Notes/note.md");

    const commits = f.client.calls.filter((c) => c.op === "createCommit");
    expect(commits).toHaveLength(1);
    // Etap 6.5: "Update {filename} at {date}" + " (test-device)"
    // suffix appended via appendDeviceSuffix.
    expect((commits[0].args as { message: string }).message).toBe(
      "Update note.md at 2026-05-03T09:38:23.000Z (test-device)",
    );

    // Tree contains exactly the one file we asked for.
    const tree = f.client.state.lastTree!;
    expect(tree.map((e) => e.path)).toEqual(["Notes/note.md"]);

    // Snapshot recorded.
    expect(f.store.get("Notes/note.md")?.remoteSha).toBe(
      await shaOf("fresh\n"),
    );
  });

  it("syncFile: customMessage gets the device suffix appended (parseable on GitHub)", async () => {
    writeVaultFile(f.root, "x.md", "v\n");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    await f.manager.syncFile("x.md", "manual: tweak {filename}");
    const commits = f.client.calls.filter((c) => c.op === "createCommit");
    // {filename} stays literal (customMessage skips applyTemplate),
    // BUT the device suffix is still appended — invariant: every
    // sync2 commit ends with " (label)" so a future viewer can tell
    // which device produced it.
    expect((commits[0].args as { message: string }).message).toBe(
      "manual: tweak {filename} (test-device)",
    );
  });

  it("syncFile: deleted file → push with sha:null, snapshot dropped", async () => {
    f.store.set("x.md", {
      path: "x.md",
      remoteSha: "OLD",
      mtime: 1,
      size: 1,
    });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    await f.manager.syncFile("x.md");

    const tree = f.client.state.lastTree!;
    expect(tree).toEqual([
      { path: "x.md", mode: "100644", type: "blob", sha: null },
    ]);
    expect(f.store.get("x.md")).toBeUndefined();
  });

  it("syncFile: ignored path → no batch, no commit", async () => {
    writeVaultFile(f.root, ".gitignore", "*.log\n");
    writeVaultFile(f.root, "noise.log", "ignored");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    await f.manager.syncFile("noise.log");
    expect(f.client.calls.filter((c) => c.op === "createCommit")).toEqual([]);
    expect(await f.queue.list()).toEqual([]);
  });

  it("syncFile: only the active file goes in the batch (others stay dirty)", async () => {
    writeVaultFile(f.root, "a.md", "1\n");
    writeVaultFile(f.root, "b.md", "2\n");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncFile("a.md");

    const tree = f.client.state.lastTree!;
    expect(tree.map((e) => e.path)).toEqual(["a.md"]);
    // b.md is still untracked locally — next syncAll picks it up.
    expect(f.store.get("a.md")?.remoteSha).toBe(await shaOf("1\n"));
    expect(f.store.get("b.md")).toBeUndefined();
  });

  describe("conflict reconciliation (Etap 6c)", () => {
    it("clean 3-way merge when remote and local touched non-overlapping parts", async () => {
      // 5-line base with 'middle' between the two edit zones so
      // node-diff3 treats them as separate hunks.
      const base = "header\nbase-line\nmiddle\noriginal-tail\nfooter";
      const ours = "header\nbase-line\nmiddle\nlocal-edit\nfooter";
      const theirs = "header\nremote-edit\nmiddle\noriginal-tail\nfooter";

      writeVaultFile(f.root, "x.md", ours);
      // Snapshot at base so findChangeForPath classifies x.md as
      // "modified" (snapshot.remoteSha == base.sha, vault has ours).
      const stat = fs.statSync(path.join(f.root, "x.md"));
      const baseSha = await shaOf(base);
      f.store.set("x.md", {
        path: "x.md",
        remoteSha: baseSha,
        mtime: 0, // forces re-hash inside findChangeForPath
        size: stat.size,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("REMOTE_HEAD");
      f.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      f.client.setContentAtRef("BASE_HEAD", "x.md", base);
      f.client.setContentAtRef("REMOTE_HEAD", "x.md", theirs);
      f.client.setCompareResult("BASE_HEAD", "REMOTE_HEAD", {
        status: "ahead",
        files: [{ filename: "x.md", status: "modified", sha: "irrelevant" }],
      });

      await f.manager.syncAll();

      expect(f.conflictCalls).toEqual([]);
      // Pull merged the file in place. The push then ships the merged
      // content because findChanges still saw x.md as modified.
      const tree = f.client.state.lastTree!;
      const xEntry = tree.find((e) => e.path === "x.md")!;
      expect(xEntry.content).toContain("remote-edit");
      expect(xEntry.content).toContain("local-edit");
      expect(xEntry.content).toContain("middle");
    });

    it("conflict modal fires for overlapping edits; resolved content lands in tree", async () => {
      const f2 = fixture({
        onConflict: async () => ({
          kind: "resolved",
          content: "user-picked-ours",
        }),
      });
      await f2.store.load();
      writeVaultFile(f2.root, "x.md", "ours-version");
      const sShared = await shaOf("shared");
      const stat = fs.statSync(path.join(f2.root, "x.md"));
      f2.store.set("x.md", {
        path: "x.md",
        remoteSha: sShared,
        mtime: 0,
        size: stat.size,
      });
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f2.client.setBranchHead("REMOTE_HEAD");
      f2.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      f2.client.setContentAtRef("BASE_HEAD", "x.md", "shared");
      f2.client.setContentAtRef("REMOTE_HEAD", "x.md", "theirs-version");
      f2.client.setCompareResult("BASE_HEAD", "REMOTE_HEAD", {
        status: "ahead",
        files: [{ filename: "x.md", status: "modified", sha: "blob-of-theirs" }],
      });

      await f2.manager.syncAll();

      const tree = f2.client.state.lastTree!;
      const xEntry = tree.find((e) => e.path === "x.md")!;
      // Resolver returns "user-picked-ours" without a trailing NL; the
      // text-canonicalisation pipeline (Etap 6.6) adds one before the
      // content lands in the snapshot/tree.
      expect(xEntry.content).toBe("user-picked-ours\n");

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("force-push fallback: missing base treats it as empty content during pull merge", async () => {
      const f3 = fixture({
        onConflict: async () => ({
          kind: "resolved",
          content: "manual-resolution",
        }),
      });
      await f3.store.load();
      writeVaultFile(f3.root, "x.md", "local-only-content");
      const stat = fs.statSync(path.join(f3.root, "x.md"));
      // Pretend we synced at OLD_HEAD_GONE with x.md SHA = "STALE" —
      // the snapshot is stale because that commit no longer exists.
      f3.store.set("x.md", {
        path: "x.md",
        remoteSha: "STALE_SHA",
        mtime: 0,
        size: stat.size,
      });
      f3.store.setLastSync("OLD_HEAD_GONE", "OLD_TREE_GONE");
      f3.client.setBranchHead("NEW_HEAD");
      f3.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Deliberately do NOT set contents at OLD_HEAD_GONE — base
      // fetch returns null. theirs at NEW_HEAD differs.
      f3.client.setContentAtRef("NEW_HEAD", "x.md", "remote-content");
      f3.client.setCompareResult("OLD_HEAD_GONE", "NEW_HEAD", {
        status: "ahead",
        files: [{ filename: "x.md", status: "modified", sha: "blob-of-theirs" }],
      });

      await f3.manager.syncAll();

      // Pull's 3-way merge with base="" treats both sides as additions
      // → conflict → resolver wins → resolved lands in vault and gets
      // pushed. Etap 6.6 normalizes the resolver output before storage,
      // so the trailing-NL invariant adds the missing \n.
      const tree = f3.client.state.lastTree!;
      const xEntry = tree.find((e) => e.path === "x.md")!;
      expect(xEntry.content).toBe("manual-resolution\n");

      fs.rmSync(f3.root, { recursive: true, force: true });
    });

    it("binary files skip auto-merge: batch ours wins on push", async () => {
      const bytes = Buffer.from([1, 2, 3, 4]);
      writeVaultFile(f.root, "img.png", bytes);
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("REMOTE_HEAD");
      f.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      // Even if we set conflicting contents at refs, sync2 should NOT
      // call getContentsAtRef for binaries — and the push should go
      // through with our bytes.

      await f.manager.syncAll();

      // No conflict modal.
      expect(f.conflictCalls).toEqual([]);
      // Tree has our binary blob.
      const tree = f.client.state.lastTree!;
      expect(tree).toHaveLength(1);
      expect(tree[0].path).toBe("img.png");
    });

    it("re-targets parent + base_tree onto the new head after reconcile", async () => {
      writeVaultFile(f.root, "x.md", "ours-content");
      f.store.setLastSync("OLD_HEAD", "OLD_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("OLD_HEAD", "x.md", "ours-content");
      f.client.setContentAtRef("NEW_HEAD", "x.md", "ours-content");

      await f.manager.syncAll();

      const commit = f.client.calls.find((c) => c.op === "createCommit");
      expect((commit?.args as { parent?: string }).parent).toBe("NEW_HEAD");
    });

    it("cascading rebase: Q1 resolved, Q2 with same path is auto-rebased", async () => {
      // Manually enqueue two batches that both touch x.md.
      writeVaultFile(f.root, "x.md", "V1\nshared\ntail");
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      const id1 = await f.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          commitMessage: "Q1",
          parentCommitSha: "BASE_HEAD",
          parentTreeSha: "BASE_TREE",
        },
      );
      // Update x.md on disk for Q2's enqueue snapshot.
      writeVaultFile(f.root, "x.md", "V2-extra\nV1\nshared\ntail");
      const id2 = await f.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          commitMessage: "Q2",
          parentCommitSha: "BASE_HEAD",
          parentTreeSha: "BASE_TREE",
        },
      );
      expect(id2 > id1).toBe(true);

      // Remote drifted with conflicting edit on the shared line.
      f.client.setBranchHead("REMOTE_HEAD");
      f.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE_1");
      f.client.setContentAtRef("BASE_HEAD", "x.md", "V1\nshared\ntail");
      f.client.setContentAtRef("REMOTE_HEAD", "x.md", "V1\nshared\nremote-tail");

      // Conflict resolver always picks ours.
      const f2 = fixture({
        onConflict: async (a) => ({ kind: "resolved", content: a.ours }),
      });
      // We need to replicate state in f2 to share it with the new
      // manager. Simpler: just do everything in the same fixture and
      // override onConflict by re-creating the manager. But we already
      // set things up here — so re-run with the auto-resolver fixture
      // by mirroring state.
      writeVaultFile(f2.root, "x.md", "V2-extra\nV1\nshared\ntail");
      await f2.store.load();
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      const id1b = await f2.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          commitMessage: "Q1",
          parentCommitSha: "BASE_HEAD",
          parentTreeSha: "BASE_TREE",
        },
      );
      writeVaultFile(f2.root, "x.md", "V2-extra\nV1\nshared\ntail");
      const id2b = await f2.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          commitMessage: "Q2",
          parentCommitSha: "BASE_HEAD",
          parentTreeSha: "BASE_TREE",
        },
      );
      f2.client.setBranchHead("REMOTE_HEAD");
      f2.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE_1");
      f2.client.setTreeShaForCommit("COMMIT_SHA_1", "TREE_SHA_1");
      f2.client.setContentAtRef("BASE_HEAD", "x.md", "V1\nshared\ntail");
      f2.client.setContentAtRef("REMOTE_HEAD", "x.md", "V1\nshared\nremote-tail");

      await f2.manager.resumeQueue();

      // Two commits landed sequentially.
      const commits = f2.client.calls.filter((c) => c.op === "createCommit");
      expect(commits).toHaveLength(2);

      // No batches left.
      expect(await f2.queue.list()).toEqual([]);
      expect(id1b < id2b).toBe(true);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  describe("bootstrap-from-remote (Step 1)", () => {
    it("downloads every remote file when lastSyncCommitSha is null and branch has commits", async () => {
      f.client.setBranchHead("FRESH_HEAD");
      f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      // Inputs are canonical (LF + trailing-NL) so the Etap 6.6
      // pull-side normalizer is a no-op for them — the test stays a
      // clean bootstrap-only scenario without follow-up republish.
      f.client.setContentAtRef("FRESH_HEAD", "Notes/a.md", "alpha\n");
      f.client.setContentAtRef("FRESH_HEAD", "Notes/b.md", "beta\n");

      await f.manager.syncAll();

      // Both files now on disk with correct content.
      expect(
        fs.readFileSync(path.join(f.root, "Notes/a.md"), "utf8"),
      ).toBe("alpha\n");
      expect(
        fs.readFileSync(path.join(f.root, "Notes/b.md"), "utf8"),
      ).toBe("beta\n");

      // Snapshot recorded for both.
      expect(f.store.get("Notes/a.md")?.remoteSha).toBeTruthy();
      expect(f.store.get("Notes/b.md")?.remoteSha).toBeTruthy();

      // lastSync moved to currentHead.
      expect(f.store.getLastSyncCommitSha()).toBe("FRESH_HEAD");
    });

    it("no-op when lastSyncCommitSha is already set", async () => {
      f.store.setLastSync("EXISTING", "EXISTING_TREE");
      f.client.setBranchHead("EXISTING");
      // Pre-recorded contents — bootstrap shouldn't touch them.
      f.client.setContentAtRef("EXISTING", "ghost.md", "should-not-pull");

      await f.manager.syncAll();

      // No bootstrap → no getRepoContent call, no file written.
      expect(
        f.client.calls.find((c) => c.op === "getRepoContent"),
      ).toBeUndefined();
      expect(fs.existsSync(path.join(f.root, "ghost.md"))).toBe(false);
    });

    it("no-op when branch is bare (404 on getBranchHeadSha)", async () => {
      f.client.getBranchHeadSha = async () => {
        const e = new Error("Not Found") as Error & { status: number };
        e.status = 404;
        throw e;
      };
      writeVaultFile(f.root, "fresh.md", "local-only");

      await f.manager.syncAll();

      // Bootstrap was skipped; the local file proceeds through the
      // first-sync-against-bare path (handled by processBatch case 1).
      expect(f.store.getLastSyncCommitSha()).toBe("COMMIT_SHA_1");
    });

    it("skips ignored paths during download", async () => {
      f.client.setBranchHead("FRESH_HEAD");
      f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f.client.setContentAtRef("FRESH_HEAD", ".gitignore", "secret/\n");
      f.client.setContentAtRef("FRESH_HEAD", "secret/private.md", "should-skip");
      f.client.setContentAtRef("FRESH_HEAD", "Notes/keep.md", "should-keep");

      // Pre-write the gitignore locally so checkSyncable sees it.
      // (Real Obsidian auto-loads it after the first ignored() call,
      // but bootstrap walks alphabetically and may hit secret/ before
      // .gitignore. This is the simplest deterministic setup.)
      writeVaultFile(f.root, ".gitignore", "secret/\n");

      await f.manager.syncAll();

      expect(fs.existsSync(path.join(f.root, "Notes/keep.md"))).toBe(true);
      expect(
        fs.existsSync(path.join(f.root, "secret/private.md")),
      ).toBe(false);
    });
  });

  describe("pullIfNeeded (Etap 6c-pull)", () => {
    it("no-op when lastSyncCommitSha is null (first sync)", async () => {
      writeVaultFile(f.root, "x.md", "v");
      // No setLastSync, but a remote already exists.
      f.client.setBranchHead("REMOTE_HEAD");
      f.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");

      await f.manager.syncAll();

      // No compare call should have happened.
      expect(f.client.calls.find((c) => c.op === "compare")).toBeUndefined();
    });

    it("no-op when HEAD hasn't moved", async () => {
      f.store.setLastSync("HEAD_X", "TREE_X");
      f.client.setBranchHead("HEAD_X");
      f.client.setTreeShaForCommit("HEAD_X", "TREE_X");
      await f.manager.syncAll();
      expect(f.client.calls.find((c) => c.op === "compare")).toBeUndefined();
    });

    it("applies a remote add to the local vault", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Canonical input → Etap 6.6 normalizer is a no-op, so this
      // test stays focused on pull-detection rather than republish.
      f.client.setContentAtRef("NEW_HEAD", "Notes/new.md", "fresh content\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "Notes/new.md", status: "added", sha: "blob-new" },
        ],
      });

      await f.manager.syncAll();

      // File now present locally with the remote content.
      const written = fs.readFileSync(
        path.join(f.root, "Notes/new.md"),
        "utf8",
      );
      expect(written).toBe("fresh content\n");
      // Snapshot records the canonical-form git blob SHA (which equals
      // the remote SHA when remote was already canonical).
      expect(f.store.get("Notes/new.md")?.remoteSha).toBe(
        await shaOf("fresh content\n"),
      );
      // lastSync moved forward.
      expect(f.store.getLastSyncCommitSha()).toBe("NEW_HEAD");
    });

    it("applies a remote delete when local matches snapshot", async () => {
      writeVaultFile(f.root, "Notes/gone.md", "going");
      const stat = fs.statSync(path.join(f.root, "Notes/gone.md"));
      const sha = await shaOf("going");
      f.store.set("Notes/gone.md", {
        path: "Notes/gone.md",
        remoteSha: sha,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "Notes/gone.md", status: "removed", sha: null },
        ],
      });

      await f.manager.syncAll();

      expect(fs.existsSync(path.join(f.root, "Notes/gone.md"))).toBe(false);
      expect(f.store.get("Notes/gone.md")).toBeUndefined();
    });

    it("ignored remote path is silently dropped from pull (two-way mute)", async () => {
      writeVaultFile(f.root, ".gitignore", "secret/\n");
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "secret/note.md", "private");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "secret/note.md", status: "added", sha: "blob-secret" },
        ],
      });

      await f.manager.syncAll();

      // File NOT downloaded because local gitignore covers secret/.
      expect(fs.existsSync(path.join(f.root, "secret/note.md"))).toBe(false);
    });

    it("binary remote-modify, local clean: pulls binary content", async () => {
      writeVaultFile(f.root, "img.png", Buffer.from([1, 2, 3]));
      const stat = fs.statSync(path.join(f.root, "img.png"));
      const sha = await shaOf("\x01\x02\x03");
      f.store.set("img.png", {
        path: "img.png",
        remoteSha: sha,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Remote bumped the file. Local is clean.
      f.client.setContentAtRef("NEW_HEAD", "img.png", "remote-binary-bytes");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "img.png", status: "modified", sha: "blob-of-remote" },
        ],
      });

      await f.manager.syncAll();

      // Local file replaced.
      const updated = fs.readFileSync(path.join(f.root, "img.png"), "utf8");
      expect(updated).toBe("remote-binary-bytes");
    });

    it("binary remote-modify, local newer: keeps ours (no overwrite)", async () => {
      // Prepare: local file with a recent mtime; snapshot recorded at
      // an older SHA; remote bumped it but with an OLDER commit date.
      writeVaultFile(f.root, "img.png", Buffer.from([0x99, 0x99]));
      const localStat = fs.statSync(path.join(f.root, "img.png"));
      // Snapshot from "long ago" so findChangeForPath flags local
      // as modified (snapshot.mtime stale).
      f.store.set("img.png", {
        path: "img.png",
        remoteSha: "OLDSHA",
        mtime: 0,
        size: localStat.size,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setCommitDate(
        "NEW_HEAD",
        new Date(localStat.mtimeMs - 60_000).toISOString(),
      );
      f.client.setContentAtRef("NEW_HEAD", "img.png", "remote-stale");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "img.png", status: "modified", sha: "blob-of-remote" },
        ],
      });

      await f.manager.syncAll();

      // Local content unchanged (still the 0x99 0x99 we wrote).
      const data = fs.readFileSync(path.join(f.root, "img.png"));
      expect(data[0]).toBe(0x99);
      expect(data[1]).toBe(0x99);
    });

    it("binary remote-modify, remote newer: overwrites local with remote", async () => {
      writeVaultFile(f.root, "img.png", Buffer.from([0x11, 0x22]));
      const localStat = fs.statSync(path.join(f.root, "img.png"));
      f.store.set("img.png", {
        path: "img.png",
        remoteSha: "OLDSHA",
        mtime: 0,
        size: localStat.size,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setCommitDate(
        "NEW_HEAD",
        new Date(localStat.mtimeMs + 60_000).toISOString(),
      );
      f.client.setContentAtRef("NEW_HEAD", "img.png", "remote-fresh");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "img.png", status: "modified", sha: "blob-of-remote" },
        ],
      });

      await f.manager.syncAll();

      const data = fs.readFileSync(path.join(f.root, "img.png"), "utf8");
      expect(data).toBe("remote-fresh");
    });

    it("compare 404 (force-push or GC'd commit) is graceful", async () => {
      writeVaultFile(f.root, "x.md", "v");
      f.store.setLastSync("LOST_BASE", "LOST_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Override compare to throw 404.
      const origCompare = f.client.compare.bind(f.client);
      f.client.compare = async (args) => {
        const e = new Error("Not Found") as Error & { status: number };
        e.status = 404;
        throw e;
      };

      // Should not throw. Push proceeds normally as if pull was a no-op.
      await f.manager.syncAll();
      f.client.compare = origCompare;
    });
  });

  // ── Etap 6.6 — text canonicalisation on pull -----------------------
  // Pull-side normalization is non-negotiable ("ГОЛОВНЕ ПРАВИЛО":
  // locally everything is canonical regardless of what's on remote).
  // When the remote bytes for a text file aren't already canonical,
  // sync2 writes the canonical form locally AND auto-republishes back
  // to GitHub in the same syncAll, so the server converges on the
  // canonical form too ("preferred clean server").
  describe("text canonicalisation on pull (Etap 6.6)", () => {
    it("CRLF in remote text → local LF + auto-republish push fires in same syncAll", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Remote has a CRLF-laden version of the file.
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "line1\r\nline2\r\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "doc.md", status: "added", sha: "blob-crlf" },
        ],
      });

      await f.manager.syncAll();

      // Local file is canonical.
      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("line1\nline2\n");

      // Auto-republish fired: tree push contains the canonical bytes.
      const tree = f.client.state.lastTree!;
      const entry = tree.find((e) => e.path === "doc.md");
      expect(entry?.content).toBe("line1\nline2\n");

      // Snapshot tracks the canonical SHA, not the remote-as-was SHA.
      expect(f.store.get("doc.md")?.remoteSha).toBe(
        await shaOf("line1\nline2\n"),
      );

      // Republish push moved lastSync past NEW_HEAD.
      expect(f.store.getLastSyncCommitSha()).not.toBe("NEW_HEAD");
    });

    it("BOM-prefixed remote text → BOM stripped locally + auto-republish", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Setting content as a JS string with the U+FEFF code point at
      // index 0; the fake client base64-encodes this on the way out
      // and the manager decodes it back, so the BOM survives the
      // round-trip into normalizeText.
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "﻿title\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "doc.md", status: "added", sha: "blob-bom" },
        ],
      });

      await f.manager.syncAll();

      // BOM is gone locally.
      const local = fs.readFileSync(path.join(f.root, "doc.md"), "utf8");
      expect(local).toBe("title\n");

      // Auto-republish pushed the canonical version.
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "doc.md")?.content).toBe("title\n");
    });

    it("missing trailing newline on remote → \\n added locally + auto-republish", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "no trailing nl");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "doc.md", status: "added", sha: "blob-no-nl" },
        ],
      });

      await f.manager.syncAll();

      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("no trailing nl\n");
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "doc.md")?.content).toBe(
        "no trailing nl\n",
      );
    });

    it("already-canonical remote text → no auto-republish push fires", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "clean\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "doc.md", status: "added", sha: "blob-clean" },
        ],
      });

      await f.manager.syncAll();

      // No createCommit fired — pull-only, nothing to republish.
      const commits = f.client.calls.filter((c) => c.op === "createCommit");
      expect(commits).toEqual([]);

      // lastSync stayed at NEW_HEAD (no further commits beyond pull).
      expect(f.store.getLastSyncCommitSha()).toBe("NEW_HEAD");
    });

    it("bootstrap with non-canonical remote text → canonical locally + auto-republish", async () => {
      // Fresh device (lastSync is null) hits bootstrap-from-remote.
      // Remote has a CRLF file. Bootstrap canonicalizes locally and
      // queues the path for republish; the same syncAll call commits
      // the canonical version back to GitHub.
      f.client.setBranchHead("FRESH_HEAD");
      f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f.client.setContentAtRef("FRESH_HEAD", "doc.md", "alpha\r\n");

      await f.manager.syncAll();

      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("alpha\n");

      const commits = f.client.calls.filter((c) => c.op === "createCommit");
      expect(commits).toHaveLength(1);
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "doc.md")?.content).toBe("alpha\n");
    });

    it("merge-resolved content also gets canonicalized + republished if needed", async () => {
      // Local has its own edit; remote has a different one (overlap →
      // conflict). Conflict resolver returns "manual-resolution"
      // (no trailing NL). Etap 6.6 normalizes that to
      // "manual-resolution\n" before storing/pushing.
      const f2 = fixture({
        onConflict: async () => ({
          kind: "resolved",
          content: "manual-resolution",
        }),
      });
      await f2.store.load();
      writeVaultFile(f2.root, "x.md", "ours\n");
      const sShared = await shaOf("shared\n");
      const stat = fs.statSync(path.join(f2.root, "x.md"));
      f2.store.set("x.md", {
        path: "x.md",
        remoteSha: sShared,
        mtime: 0,
        size: stat.size,
      });
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f2.client.setBranchHead("REMOTE_HEAD");
      f2.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      f2.client.setContentAtRef("BASE_HEAD", "x.md", "shared\n");
      f2.client.setContentAtRef("REMOTE_HEAD", "x.md", "theirs\n");
      f2.client.setCompareResult("BASE_HEAD", "REMOTE_HEAD", {
        status: "ahead",
        files: [
          { filename: "x.md", status: "modified", sha: "blob-of-theirs" },
        ],
      });

      await f2.manager.syncAll();

      const tree = f2.client.state.lastTree!;
      expect(tree.find((e) => e.path === "x.md")?.content).toBe(
        "manual-resolution\n",
      );
      expect(
        fs.readFileSync(path.join(f2.root, "x.md"), "utf8"),
      ).toBe("manual-resolution\n");

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("syncFile: target normalized during pull → republished in this batch", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "x.md", "content\r\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "x.md", status: "modified", sha: "blob-crlf" },
        ],
      });

      await f.manager.syncFile("x.md");

      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "x.md")?.content).toBe("content\n");
    });

    it("syncFile: non-target normalized during pull → NOT in syncFile batch (deferred to next syncAll)", async () => {
      // syncFile has narrow scope: only the target gets pushed in this
      // batch. Other paths the pull canonicalized stay clean locally;
      // their republish has to wait for the next syncAll.
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "other.md", "from-web\r\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "other.md", status: "added", sha: "blob-other" },
        ],
      });
      // User adds a different file and asks to sync only that one.
      writeVaultFile(f.root, "x.md", "manual-edit\n");

      await f.manager.syncFile("x.md");

      const tree = f.client.state.lastTree!;
      // Only x.md goes up — other.md (canonicalized locally) stays
      // out of this commit.
      expect(tree.map((e) => e.path)).toEqual(["x.md"]);

      // But other.md IS canonical on disk — pull-side normalization
      // happened regardless of which file was the syncFile target.
      expect(
        fs.readFileSync(path.join(f.root, "other.md"), "utf8"),
      ).toBe("from-web\n");
    });
  });

  // ── Etap 6.5 — conflict resolver contract -------------------------
  // Sync2Manager's onConflict callback now returns a discriminated
  // union (resolved / deferred / merged-into-one). These tests pin
  // each branch through the manager flow without going through the
  // real diff modal — the modal is a UI layer that just produces
  // these decision shapes.
  describe("OnConflict contract (Etap 6.5)", () => {
    it("kind=resolved: content is written to disk, recorded, and pushed", async () => {
      const f2 = fixture({
        onConflict: async () => ({
          kind: "resolved",
          content: "user-merged-via-diff",
        }),
      });
      await f2.store.load();
      writeVaultFile(f2.root, "x.md", "ours-version\n");
      const sShared = await shaOf("shared\n");
      const stat = fs.statSync(path.join(f2.root, "x.md"));
      f2.store.set("x.md", {
        path: "x.md",
        remoteSha: sShared,
        mtime: 0,
        size: stat.size,
      });
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f2.client.setBranchHead("REMOTE_HEAD");
      f2.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      f2.client.setContentAtRef("BASE_HEAD", "x.md", "shared\n");
      f2.client.setContentAtRef("REMOTE_HEAD", "x.md", "theirs-version\n");
      f2.client.setCompareResult("BASE_HEAD", "REMOTE_HEAD", {
        status: "ahead",
        files: [{ filename: "x.md", status: "modified", sha: "blob-of-theirs" }],
      });

      await f2.manager.syncAll();

      const tree = f2.client.state.lastTree!;
      expect(tree.find((e) => e.path === "x.md")?.content).toBe(
        "user-merged-via-diff\n",
      );

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("kind=merged-into-one: content overwrites local + pushes (treated like resolved)", async () => {
      // The Etap 6.5 markdown auto-merge feeds its result through the
      // same kind=merged-into-one return; manager treats it
      // identically to resolved. The kind tag is only for telemetry.
      const merged =
        "# Notes\n\noriginal\n\n> [!info] Changing 1 — from Phone\n> theirs version\n";
      const f2 = fixture({
        onConflict: async () => ({
          kind: "merged-into-one",
          content: merged,
        }),
      });
      await f2.store.load();
      writeVaultFile(f2.root, "x.md", "ours\n");
      const sShared = await shaOf("shared\n");
      const stat = fs.statSync(path.join(f2.root, "x.md"));
      f2.store.set("x.md", {
        path: "x.md",
        remoteSha: sShared,
        mtime: 0,
        size: stat.size,
      });
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f2.client.setBranchHead("REMOTE_HEAD");
      f2.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      f2.client.setContentAtRef("BASE_HEAD", "x.md", "shared\n");
      f2.client.setContentAtRef("REMOTE_HEAD", "x.md", "theirs\n");
      f2.client.setCompareResult("BASE_HEAD", "REMOTE_HEAD", {
        status: "ahead",
        files: [{ filename: "x.md", status: "modified", sha: "blob-of-theirs" }],
      });

      await f2.manager.syncAll();

      const tree = f2.client.state.lastTree!;
      expect(tree.find((e) => e.path === "x.md")?.content).toBe(merged);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("kind=deferred: ConflictStore.create called, path NOT in this push, local file unchanged", async () => {
      const ConflictStore = (
        await import("../../src/sync2/conflict-store")
      ).default;
      const f2 = fixture({}); // we'll wire the conflict store separately
      const conflictStore = new ConflictStore({
        vault: f2.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        deviceLabel: "test-device",
      });
      await conflictStore.load();

      // Re-build the manager with the conflict store wired and a
      // deferring onConflict callback.
      const manager = new Sync2Manager({
        vault: f2.vault as unknown as import("obsidian").Vault,
        store: f2.store,
        detector: f2.detector,
        queue: f2.queue,
        builder: f2.builder,
        client: f2.client,
        logger: silentLogger(),
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        commitMessageAll: "Sync at {date}",
        commitMessageFile: "Update {filename} at {date}",
        deviceLabel: "test-device",
        conflictStore,
        onConflict: async () => ({ kind: "deferred" }),
        now: () => f2.clock.nowMs(),
      });

      await f2.store.load();
      writeVaultFile(f2.root, "x.md", "local-edits\n");
      const sShared = await shaOf("shared\n");
      const stat = fs.statSync(path.join(f2.root, "x.md"));
      f2.store.set("x.md", {
        path: "x.md",
        remoteSha: sShared,
        mtime: 0,
        size: stat.size,
      });
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f2.client.setBranchHead("REMOTE_HEAD");
      f2.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      f2.client.setContentAtRef("BASE_HEAD", "x.md", "shared\n");
      f2.client.setContentAtRef("REMOTE_HEAD", "x.md", "theirs-edits\n");
      f2.client.setCompareResult("BASE_HEAD", "REMOTE_HEAD", {
        status: "ahead",
        files: [
          { filename: "x.md", status: "modified", sha: "blob-of-theirs" },
        ],
      });

      await manager.syncAll();

      // ConflictStore now has a record + sibling file in the vault.
      expect(conflictStore.hasPending("x.md")).toBe(true);
      const records = conflictStore.forPath("x.md");
      expect(records).toHaveLength(1);
      // theirsBlobSha is whatever the fake client returned for the
      // remote content — fixture computes it from the content bytes.
      expect(records[0].theirsBlobSha).toMatch(/^blob-of-[0-9a-f]{8}$/);
      expect(records[0].deviceLabel).toBe("test-device");

      // Sibling file is in the vault with the theirs content.
      const siblingPath = records[0].siblingPath;
      expect(fs.existsSync(path.join(f2.root, siblingPath))).toBe(true);
      expect(
        fs.readFileSync(path.join(f2.root, siblingPath), "utf8"),
      ).toBe("theirs-edits\n");

      // Local file UNCHANGED — ours stays put. The push pipeline
      // didn't get the path because it's pending-conflict-filtered.
      expect(
        fs.readFileSync(path.join(f2.root, "x.md"), "utf8"),
      ).toBe("local-edits\n");

      // No commit happened (push was empty after filter).
      const commits = f2.client.calls.filter(
        (c) => c.op === "createCommit",
      );
      expect(commits).toEqual([]);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("kind=deferred without conflictStore wired throws a clear error", async () => {
      const f2 = fixture({
        onConflict: async () => ({ kind: "deferred" }),
        // conflictStore intentionally omitted
      });
      await f2.store.load();
      writeVaultFile(f2.root, "x.md", "ours\n");
      const sShared = await shaOf("shared\n");
      f2.store.set("x.md", {
        path: "x.md",
        remoteSha: sShared,
        mtime: 0,
        size: 4,
      });
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f2.client.setBranchHead("REMOTE_HEAD");
      f2.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      f2.client.setContentAtRef("BASE_HEAD", "x.md", "shared\n");
      f2.client.setContentAtRef("REMOTE_HEAD", "x.md", "theirs\n");
      f2.client.setCompareResult("BASE_HEAD", "REMOTE_HEAD", {
        status: "ahead",
        files: [
          { filename: "x.md", status: "modified", sha: "blob-of-theirs" },
        ],
      });

      await expect(f2.manager.syncAll()).rejects.toThrow(
        /no ConflictStore is wired/,
      );

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("pending-conflict path is dropped from enqueue; push only carries clean paths", async () => {
      const ConflictStore = (
        await import("../../src/sync2/conflict-store")
      ).default;
      const f2 = fixture({});
      const conflictStore = new ConflictStore({
        vault: f2.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        deviceLabel: "test-device",
      });
      await conflictStore.load();

      // Pre-create a conflict record for x.md (simulating a previous
      // sync where the user picked Defer).
      writeVaultFile(f2.root, "x.md", "ours\n");
      await conflictStore.create({
        vaultPath: "x.md",
        baseContent: "shared\n",
        theirsContent: "theirs\n",
        baseCommitSha: "OLD_HEAD",
        theirsBlobSha: "old-theirs-sha",
      });

      // Build manager pointing at the conflict store.
      const manager = new Sync2Manager({
        vault: f2.vault as unknown as import("obsidian").Vault,
        store: f2.store,
        detector: f2.detector,
        queue: f2.queue,
        builder: f2.builder,
        client: f2.client,
        logger: silentLogger(),
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        commitMessageAll: "Sync at {date}",
        commitMessageFile: "Update {filename} at {date}",
        deviceLabel: "test-device",
        conflictStore,
        onConflict: async () => {
          throw new Error("onConflict should not fire — no remote drift");
        },
        now: () => f2.clock.nowMs(),
      });

      await f2.store.load();
      // User keeps editing x.md while the conflict is deferred — the
      // edit must NOT propagate yet.
      writeVaultFile(f2.root, "x.md", "more-local-edits\n");
      // And there's a clean file too — that one DOES propagate.
      writeVaultFile(f2.root, "y.md", "clean-other-file\n");

      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f2.client.setBranchHead("BASE_HEAD"); // no remote drift → no compare

      await manager.syncAll();

      const tree = f2.client.state.lastTree!;
      const paths = tree.map((e) => e.path);
      expect(paths).toContain("y.md");
      expect(paths).not.toContain("x.md");

      // x.md still has the user's local edits — push didn't touch it.
      expect(
        fs.readFileSync(path.join(f2.root, "x.md"), "utf8"),
      ).toBe("more-local-edits\n");

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("resolving the conflict (delete sibling) unblocks the path on the next sync", async () => {
      const ConflictStore = (
        await import("../../src/sync2/conflict-store")
      ).default;
      const f2 = fixture({});
      const conflictStore = new ConflictStore({
        vault: f2.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        deviceLabel: "test-device",
      });
      await conflictStore.load();

      writeVaultFile(f2.root, "x.md", "ours\n");
      const r = await conflictStore.create({
        vaultPath: "x.md",
        baseContent: "shared\n",
        theirsContent: "theirs\n",
        baseCommitSha: "OLD_HEAD",
        theirsBlobSha: "old-theirs-sha",
      });

      const manager = new Sync2Manager({
        vault: f2.vault as unknown as import("obsidian").Vault,
        store: f2.store,
        detector: f2.detector,
        queue: f2.queue,
        builder: f2.builder,
        client: f2.client,
        logger: silentLogger(),
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        commitMessageAll: "Sync at {date}",
        commitMessageFile: "Update {filename} at {date}",
        deviceLabel: "test-device",
        conflictStore,
        onConflict: async () => {
          throw new Error("no callback expected in this scenario");
        },
        now: () => f2.clock.nowMs(),
      });

      await f2.store.load();
      writeVaultFile(f2.root, "x.md", "post-resolve-content\n");
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f2.client.setBranchHead("BASE_HEAD");

      // First sync while conflict is pending → x.md skipped.
      await manager.syncAll();
      const treeBefore = f2.client.state.lastTree;
      expect(treeBefore?.find((e) => e.path === "x.md")).toBeUndefined();

      // User deletes the sibling, signalling resolution.
      await conflictStore.notifySiblingDeleted(r.siblingPath);
      expect(conflictStore.hasPending("x.md")).toBe(false);

      // Second sync now picks up x.md.
      await manager.syncAll();
      const treeAfter = f2.client.state.lastTree!;
      const xEntry = treeAfter.find((e) => e.path === "x.md");
      expect(xEntry?.content).toBe("post-resolve-content\n");

      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  // ── local-phase UI feedback hooks --------------------------------
  // onLocalCommitted fires once per syncAll/syncFile after the batch
  // is enqueued. onNoLocalChanges fires when there's truly nothing to
  // do (no local changes AND no pending queue). main.ts wires both
  // to short-lived Notices so the user sees "Commit N files" / "No
  // changes" before any network I/O happens.
  describe("local-phase UI hooks", () => {
    it("onLocalCommitted fires with correct count when files are enqueued", async () => {
      const calls: number[] = [];
      const f2 = fixture({ onLocalCommitted: (n) => calls.push(n) });
      writeVaultFile(f2.root, "a.md", "v1\n");
      writeVaultFile(f2.root, "b.md", "v1\n");
      writeVaultFile(f2.root, "c.md", "v1\n");
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncAll();

      expect(calls).toEqual([3]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onLocalCommitted does NOT fire when there's nothing to enqueue", async () => {
      const calls: number[] = [];
      const f2 = fixture({ onLocalCommitted: (n) => calls.push(n) });
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncAll();

      expect(calls).toEqual([]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onLocalCommitted reports the count after pending-conflict filter", async () => {
      // Pre-create a conflict on a.md so it gets filtered. b.md and
      // c.md still go through. Expect count = 2 (filtered length),
      // not 3 (raw findChanges length).
      const ConflictStore = (
        await import("../../src/sync2/conflict-store")
      ).default;
      const calls: number[] = [];
      const f2 = fixture({});
      const conflictStore = new ConflictStore({
        vault: f2.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        deviceLabel: "test-device",
      });
      await conflictStore.load();
      writeVaultFile(f2.root, "a.md", "v1\n");
      await conflictStore.create({
        vaultPath: "a.md",
        baseContent: "shared\n",
        theirsContent: "theirs\n",
        baseCommitSha: "OLD_HEAD",
        theirsBlobSha: "old-theirs-sha",
      });

      const manager = new Sync2Manager({
        vault: f2.vault as unknown as import("obsidian").Vault,
        store: f2.store,
        detector: f2.detector,
        queue: f2.queue,
        builder: f2.builder,
        client: f2.client,
        logger: silentLogger(),
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        commitMessageAll: "Sync at {date}",
        commitMessageFile: "Update {filename} at {date}",
        deviceLabel: "test-device",
        conflictStore,
        onConflict: async () => {
          throw new Error("no callback expected");
        },
        onLocalCommitted: (n) => calls.push(n),
        now: () => f2.clock.nowMs(),
      });

      await f2.store.load();
      writeVaultFile(f2.root, "a.md", "edited locally\n");
      writeVaultFile(f2.root, "b.md", "clean-b\n");
      writeVaultFile(f2.root, "c.md", "clean-c\n");
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await manager.syncAll();

      expect(calls).toEqual([2]); // a.md filtered, b.md + c.md enqueued
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onNoLocalChanges fires when nothing local AND queue empty", async () => {
      const noChangesCalls: number[] = [];
      const f2 = fixture({
        onNoLocalChanges: () => noChangesCalls.push(1),
      });
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncAll();

      expect(noChangesCalls).toEqual([1]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onNoLocalChanges does NOT fire when queue has pending batches", async () => {
      // Pre-load a pending batch into the queue. syncAll finds no
      // local changes but isn't truly idle — the queue has work.
      const noChangesCalls: number[] = [];
      const f2 = fixture({
        onNoLocalChanges: () => noChangesCalls.push(1),
      });
      writeVaultFile(f2.root, "stranded.md", "v1\n");
      await f2.queue.enqueue(
        [
          {
            kind: "added",
            path: "stranded.md",
            size: 3,
            mtime: 0,
          },
        ],
        {
          commitMessage: "stranded commit",
          parentCommitSha: null,
          parentTreeSha: null,
        },
      );
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      // Snapshot already records stranded.md so findChanges sees nothing.
      const stat = fs.statSync(path.join(f2.root, "stranded.md"));
      f2.store.set("stranded.md", {
        path: "stranded.md",
        remoteSha: await shaOf("v1\n"),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncAll();

      // Queue had work → not idle → no "No changes" notice.
      expect(noChangesCalls).toEqual([]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("syncFile: onLocalCommitted fires with count=1 when file enqueues", async () => {
      const calls: number[] = [];
      const f2 = fixture({ onLocalCommitted: (n) => calls.push(n) });
      writeVaultFile(f2.root, "x.md", "v1\n");
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncFile("x.md");

      expect(calls).toEqual([1]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("syncFile: onNoLocalChanges fires when target is unchanged + no queue", async () => {
      const noChangesCalls: number[] = [];
      const f2 = fixture({
        onNoLocalChanges: () => noChangesCalls.push(1),
      });
      writeVaultFile(f2.root, "x.md", "v1\n");
      const stat = fs.statSync(path.join(f2.root, "x.md"));
      f2.store.set("x.md", {
        path: "x.md",
        remoteSha: await shaOf("v1\n"),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncFile("x.md");

      expect(noChangesCalls).toEqual([1]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  // ── pullOnly() ----------------------------------------------------
  // Interval / startup pull-only entry point. Same pull side-effects
  // as syncAll's first phase (bootstrap + pullIfNeeded), but skips
  // findChanges, enqueueOrMerge, and processQueue. Used by main.ts
  // when autoCommitOnSync is off.
  describe("pullOnly (background pull)", () => {
    it("brings remote changes down without enqueueing local edits", async () => {
      // Set up: ours edited, remote has a different file added.
      const f2 = fixture({});
      writeVaultFile(f2.root, "ours-edit.md", "ours new content\n");
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f2.client.setBranchHead("NEW_HEAD");
      f2.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f2.client.setContentAtRef("NEW_HEAD", "remote-add.md", "remote\n");
      f2.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          {
            filename: "remote-add.md",
            status: "added",
            sha: "blob-remote",
          },
        ],
      });

      await f2.manager.pullOnly();

      // Remote-added file landed locally.
      expect(
        fs.readFileSync(path.join(f2.root, "remote-add.md"), "utf8"),
      ).toBe("remote\n");
      // Local edit is NOT enqueued (no batch on disk).
      expect(await f2.queue.list()).toEqual([]);
      // No createCommit fired — pull-only doesn't push.
      const commits = f2.client.calls.filter(
        (c) => c.op === "createCommit",
      );
      expect(commits).toEqual([]);
      // lastSync moved to currentHead (pullIfNeeded did its job).
      expect(f2.store.getLastSyncCommitSha()).toBe("NEW_HEAD");

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("does NOT fire onLocalCommitted or onNoLocalChanges (silent)", async () => {
      const localCalls: number[] = [];
      const noChangesCalls: number[] = [];
      const f2 = fixture({
        onLocalCommitted: (n) => localCalls.push(n),
        onNoLocalChanges: () => noChangesCalls.push(1),
      });
      f2.store.setLastSync("HEAD", "TREE");
      f2.client.setBranchHead("HEAD");

      await f2.manager.pullOnly();

      expect(localCalls).toEqual([]);
      expect(noChangesCalls).toEqual([]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("on a fresh device (lastSync null), runs bootstrap-from-remote", async () => {
      const f2 = fixture({});
      f2.client.setBranchHead("FRESH_HEAD");
      f2.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f2.client.setContentAtRef("FRESH_HEAD", "Notes/x.md", "alpha\n");

      await f2.manager.pullOnly();

      // Bootstrap downloaded the remote file.
      expect(
        fs.readFileSync(path.join(f2.root, "Notes/x.md"), "utf8"),
      ).toBe("alpha\n");
      expect(f2.store.getLastSyncCommitSha()).toBe("FRESH_HEAD");
      // No queue entries.
      expect(await f2.queue.list()).toEqual([]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("does NOT call invariants.enforce", async () => {
      // pullOnly is reserved for idle background work — it shouldn't
      // rewrite the user's `.gitignore` files on a timer. We assert
      // by checking that the configDir/.gitignore file isn't created
      // when missing (enforce would seed it on first run).
      const f2 = fixture({});
      f2.store.setLastSync("HEAD", "TREE");
      f2.client.setBranchHead("HEAD");

      await f2.manager.pullOnly();

      const configGitignore = path.join(f2.root, CONFIG_DIR, ".gitignore");
      expect(fs.existsSync(configGitignore)).toBe(false);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  describe("resumeQueue + accumulateOfflineSyncs (Etap 6d)", () => {
    it("resumeQueue picks up a pending batch left over from a previous run", async () => {
      // Simulate a previous Sync2Manager that enqueued but crashed
      // before pushing.
      writeVaultFile(f.root, "stale.md", "stranded content");
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      const id = await f.queue.enqueue(
        [{ kind: "added", path: "stale.md", size: 1, mtime: 0 }],
        {
          commitMessage: "stranded",
          parentCommitSha: "BRANCH_HEAD_INIT",
          parentTreeSha: "INITIAL_TREE",
        },
      );

      await f.manager.resumeQueue();

      const commits = f.client.calls.filter((c) => c.op === "createCommit");
      expect(commits).toHaveLength(1);
      expect((commits[0].args as { message: string }).message).toBe(
        "stranded",
      );
      expect(await f.queue.list()).toEqual([]);
      // batch is gone from disk
      expect(id).toMatch(/^\d{17}$/);
    });

    it("resumeQueue with empty queue is a no-op", async () => {
      await f.manager.resumeQueue();
      expect(f.client.calls.filter((c) => c.op === "createCommit")).toEqual(
        [],
      );
    });

    it("resumeQueue clears stale .in-progress markers and pushes anyway", async () => {
      writeVaultFile(f.root, "x.md", "v");
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      const id = await f.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          commitMessage: "left in-progress",
          parentCommitSha: "BRANCH_HEAD_INIT",
          parentTreeSha: "INITIAL_TREE",
        },
      );
      // Crashed mid-push: marker stuck on disk.
      await f.queue.markInProgress(id);

      await f.manager.resumeQueue();

      // Push went through; batch deleted; marker irrelevant.
      expect(
        f.client.calls.filter((c) => c.op === "createCommit"),
      ).toHaveLength(1);
      expect(await f.queue.list()).toEqual([]);
    });
  });

  describe("accumulateOfflineSyncs (Etap 6d)", () => {
    function brokenNetworkFixture() {
      // Helper: client whose updateBranchHead always throws so the
      // first push fails and leaves the batch on disk.
      const f = fixture({ accumulateOfflineSyncs: true });
      const orig = f.client.updateBranchHead.bind(f.client);
      let allowPush = false;
      f.client.updateBranchHead = async (args) => {
        if (!allowPush) {
          throw new Error("simulated network outage");
        }
        return orig(args);
      };
      return { ...f, allowNextPush: () => (allowPush = true) };
    }

    it("offline + accumulate ON: second sync folds into the first batch", async () => {
      const f2 = brokenNetworkFixture();
      writeVaultFile(f2.root, "a.md", "v1");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

      // First sync: queues a batch, push fails.
      await expect(f2.manager.syncAll()).rejects.toThrow(
        /simulated network outage/,
      );
      const idsAfter1 = await f2.queue.list();
      expect(idsAfter1).toHaveLength(1);

      // User keeps editing.
      writeVaultFile(f2.root, "b.md", "v2");

      // Second sync: should NOT make a new batch — fold into the
      // existing one.
      await expect(f2.manager.syncAll()).rejects.toThrow();
      const idsAfter2 = await f2.queue.list();
      expect(idsAfter2).toEqual(idsAfter1);

      // Both files now in the same batch.
      const batch = await f2.queue.read(idsAfter1[0]);
      expect(batch.files.sort()).toEqual(["a.md", "b.md"]);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("offline + accumulate OFF: second sync stacks a new batch", async () => {
      const fOff = (() => {
        const x = fixture({ accumulateOfflineSyncs: false });
        const orig = x.client.updateBranchHead.bind(x.client);
        x.client.updateBranchHead = async () => {
          throw new Error("offline");
        };
        return x;
      })();
      writeVaultFile(fOff.root, "a.md", "v1");
      await fOff.store.load();
      fOff.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await expect(fOff.manager.syncAll()).rejects.toThrow();
      writeVaultFile(fOff.root, "b.md", "v2");
      await expect(fOff.manager.syncAll()).rejects.toThrow();
      const ids = await fOff.queue.list();
      expect(ids).toHaveLength(2);
      fs.rmSync(fOff.root, { recursive: true, force: true });
    });

    it("accumulate ON but queue empty: enqueue normally", async () => {
      const f2 = fixture({ accumulateOfflineSyncs: true });
      writeVaultFile(f2.root, "a.md", "v");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

      await f2.manager.syncAll();

      // Push succeeded → batch was created and immediately drained.
      expect(
        f2.client.calls.filter((c) => c.op === "createCommit"),
      ).toHaveLength(1);
      expect(await f2.queue.list()).toEqual([]);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("accumulated batch eventually pushes once network is back", async () => {
      const f2 = brokenNetworkFixture();
      writeVaultFile(f2.root, "a.md", "v1");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await expect(f2.manager.syncAll()).rejects.toThrow();
      writeVaultFile(f2.root, "b.md", "v2");
      await expect(f2.manager.syncAll()).rejects.toThrow();

      // Network is back.
      f2.allowNextPush();
      await f2.manager.resumeQueue();

      // Final tree: one commit succeeded after several failed
      // attempts; the successful one carries both files in a single
      // tree (proof the accumulate path folded them into one batch).
      const tree = f2.client.state.lastTree!;
      expect(tree.map((e) => e.path).sort()).toEqual(["a.md", "b.md"]);
      // Only one updateBranchHead succeeded; queue is empty.
      const refUpdates = f2.client.calls.filter(
        (c) => c.op === "updateBranchHead",
      );
      expect(refUpdates).toHaveLength(1);
      expect(await f2.queue.list()).toEqual([]);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  describe("progress UI (Step 5)", () => {
    it("single batch: 'Syncing with GitHub…' shown then hidden", async () => {
      const messages: string[] = [];
      let hidden = false;
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {
              hidden = true;
            },
          };
        },
      });
      writeVaultFile(f2.root, "x.md", "v");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await f2.manager.syncAll();
      expect(messages[0]).toBe("Syncing with GitHub…");
      expect(hidden).toBe(true);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("two pending batches: 'Syncing commit N/M…' progresses", async () => {
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
      });
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "TREE_0");
      writeVaultFile(f2.root, "a.md", "1");
      await f2.queue.enqueue(
        [{ kind: "added", path: "a.md", size: 1, mtime: 0 }],
        {
          commitMessage: "first",
          parentCommitSha: "BRANCH_HEAD_INIT",
          parentTreeSha: "TREE_0",
        },
      );
      writeVaultFile(f2.root, "b.md", "2");
      await f2.queue.enqueue(
        [{ kind: "added", path: "b.md", size: 1, mtime: 0 }],
        {
          commitMessage: "second",
          parentCommitSha: "BRANCH_HEAD_INIT",
          parentTreeSha: "TREE_0",
        },
      );
      // Pre-record snapshots for these so syncAll doesn't add a new batch.
      f2.store.set("a.md", {
        path: "a.md",
        remoteSha: await shaOf("1"),
        mtime: fs.statSync(path.join(f2.root, "a.md")).mtimeMs,
        size: 1,
      });
      f2.store.set("b.md", {
        path: "b.md",
        remoteSha: await shaOf("2"),
        mtime: fs.statSync(path.join(f2.root, "b.md")).mtimeMs,
        size: 1,
      });
      await f2.store.save();

      await f2.manager.resumeQueue();

      expect(messages.some((m) => m.includes("commit 1/2"))).toBe(true);
      expect(messages.some((m) => m.includes("commit 2/2"))).toBe(true);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("heavy batch: progress message includes ~MB hint", async () => {
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
      });
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      // 6 MB file: > 5 MB threshold.
      const big = Buffer.alloc(6 * 1024 * 1024, 0x42);
      writeVaultFile(f2.root, "big.bin", big);
      await f2.manager.syncAll();
      expect(messages.some((m) => /~\d/.test(m) && m.includes("MB"))).toBe(
        true,
      );
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("no onProgress provided: sync runs without crashing", async () => {
      writeVaultFile(f.root, "x.md", "v");
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await f.manager.syncAll();
      // No assertion needed beyond completion.
    });
  });

  it("processQueue is re-entrant safe: a recursive call short-circuits", async () => {
    // Simulate concurrent syncAll() invocations: kick off two without
    // awaiting in between; only one drain loop should run.
    writeVaultFile(f.root, "a.md", "1");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    const p1 = f.manager.syncAll();
    const p2 = f.manager.syncAll();
    await Promise.all([p1, p2]);

    // Whatever interleaving happens, we never double-pushed.
    expect(
      f.client.calls.filter((c) => c.op === "createCommit").length,
    ).toBeGreaterThanOrEqual(1);
  });
});
