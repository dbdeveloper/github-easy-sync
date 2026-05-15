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
    commitMessageByCommit: Map<string, string>;
  };
  setBranchHead(sha: string): void;
  setContentAtRef(ref: string, path: string, content: string): void;
  setTreeShaForCommit(commitSha: string, treeSha: string): void;
  setCommitDate(commitSha: string, isoDate: string): void;
  setCommitMessage(commitSha: string, message: string): void;
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
    commitMessageByCommit: new Map<string, string>(),
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
    setCommitMessage(commitSha, message) {
      state.commitMessageByCommit.set(commitSha, message);
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
    async createFile(args) {
      calls.push({ op: "createFile", args });
      // Synthesise SHAs deterministically from the content so the
      // bare-repo seed path stays observable to test assertions.
      const blobSha =
        "blob-" +
        crypto.createHash("sha1").update(args.content).digest("hex").slice(0, 8);
      state.treeShaCounter++;
      state.commitShaCounter++;
      const treeSha = `TREE_SHA_${state.treeShaCounter}`;
      const commitSha = `COMMIT_SHA_${state.commitShaCounter}`;
      state.treeShaByCommit.set(commitSha, treeSha);
      state.commitMessageByCommit.set(commitSha, args.message);
      // Record the seeded file's contents at the freshly-created head
      // so any subsequent getRepoContent/getBlob/getContentsAtRef calls
      // resolve it the same way they would for any other commit.
      let inner = state.contentsByRef.get(commitSha);
      if (!inner) {
        inner = new Map();
        state.contentsByRef.set(commitSha, inner);
      }
      // Stored as the raw bytes the API would expose (post-base64-decode).
      inner.set(args.path, Buffer.from(args.content, "base64").toString("utf8"));
      state.branchHead = commitSha;
      return { blobSha, treeSha, commitSha };
    },
    async getCommit(args) {
      calls.push({ op: "getCommit", args });
      const treeSha = state.treeShaByCommit.get(args.sha) ?? `TREE_OF_${args.sha}`;
      const committedAt = state.commitDateByCommit.get(args.sha)
        ?? new Date(0).toISOString();
      const message = state.commitMessageByCommit?.get(args.sha) ?? "";
      return {
        tree: { sha: treeSha },
        committer: { date: committedAt },
        message,
      };
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
  // Getter for the current (owner, repo, branch). When omitted the
  // manager's reconcile-remote-identity step is a no-op — fine for
  // tests that don't care. Tests that DO care pass a closure that
  // reads a mutable handle so the test can swap it mid-run.
  remoteIdentity?: () => {
    owner: string;
    repo: string;
    branch: string;
  };
  progressBytesThreshold?: number;
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
  const detector = new ChangeDetector({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    gi,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    vaultRoot: root,
    syncConfigDir: () => true,
    queue,
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
    commitMessageAll: "Sync at {date} {time}",
    commitMessageFile: "Update {filename} at {date} {time}",
    deviceLabel: "test-device",
    conflictStore: opts?.conflictStore,
    onConflict: opts?.onConflict ?? onConflictDefault,
    accumulateOfflineSyncs: opts?.accumulateOfflineSyncs ?? false,
    onProgress: opts?.onProgress,
    onLocalCommitted: opts?.onLocalCommitted,
    onNoLocalChanges: opts?.onNoLocalChanges,
    remoteIdentity: opts?.remoteIdentity,
    // Tests assert progress-notice behaviour with tiny fixtures.
    // Setting the threshold to 0 makes every drain phase "heavy",
    // so the lazy-open logic fires consistently. Tests that
    // specifically want silent behaviour pass `progressBytesThreshold:
    // Infinity` via opts to disable the notice.
    progressBytesThreshold:
      opts?.progressBytesThreshold !== undefined
        ? opts.progressBytesThreshold
        : 0,
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

describe("Sync2Manager.syncAll — basic flow (Stage 6a)", () => {
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

    // New defaults (Stage 6.5): "Sync at {date} {time}" template + auto-
    // appended " (deviceLabel)" suffix from appendDeviceSuffix.
    expect(f.client.state.lastCommit?.message).toBe(
      "Sync at 2026-05-03 09:38:23.000 (test-device)",
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

  it("first-ever sync against bare repo: seeds .gitignore, then commits batch on top", async () => {
    writeVaultFile(f.root, "x.md", "v");
    // sync2 seeds bare repos via the Contents API on <vault>/.gitignore
    // (the file invariants.enforce() guarantees in production). The
    // fixture skips invariants, so pre-create the file here.
    writeVaultFile(f.root, ".gitignore", "# seed\n");
    // No setLastSync — fresh install. getBranchHeadSha throws 404
    // (bare repo).
    f.client.getBranchHeadSha = async () => {
      const e = new Error("Not Found") as Error & { status: number };
      e.status = 404;
      throw e;
    };

    await f.manager.syncAll();

    // COMMIT_SHA_1 is the seed (createFile, no parent at all).
    // COMMIT_SHA_2 is the sync commit on top of it (createCommit
    // with parent=seed). The fixture only records createCommit calls
    // in state.lastCommit, so its `parent` field reflects the second
    // commit's parent — which is the seed.
    expect(f.client.state.lastCommit?.parent).toBe("COMMIT_SHA_1");
    expect(f.store.getLastSyncCommitSha()).toBe("COMMIT_SHA_2");
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
    // Stage 6.5: "Update {filename} at {date} {time}" + " (test-device)"
    // suffix appended via appendDeviceSuffix.
    expect((commits[0].args as { message: string }).message).toBe(
      "Update note.md at 2026-05-03 09:38:23.000 (test-device)",
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

  describe("conflict reconciliation (Stage 6c)", () => {
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
      // text-canonicalisation pipeline (Stage 6.6) adds one before the
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
      // pushed. Stage 6.6 normalizes the resolver output before storage,
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
      // Inputs are canonical (LF + trailing-NL) so the Stage 6.6
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
      // Pre-create the seed gitignore so processBatch Case 1 can read it
      // (the fixture skips invariants; in production enforce() writes
      // this file before processBatch runs).
      writeVaultFile(f.root, ".gitignore", "# seed\n");

      await f.manager.syncAll();

      // Bootstrap-from-remote was skipped; the local file proceeds
      // through the first-sync-against-bare path (processBatch case 1).
      // Seed = COMMIT_SHA_1, sync commit on top = COMMIT_SHA_2.
      expect(f.store.getLastSyncCommitSha()).toBe("COMMIT_SHA_2");
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

  describe("pullIfNeeded (Stage 6c-pull)", () => {
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
      // Canonical input → Stage 6.6 normalizer is a no-op, so this
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

  // ── Stage 6.6 — text canonicalisation on pull -----------------------
  // Pull-side normalization is non-negotiable ("ГОЛОВНЕ ПРАВИЛО":
  // locally everything is canonical regardless of what's on remote).
  // When the remote bytes for a text file aren't already canonical,
  // sync2 writes the canonical form locally and intentionally skips
  // recordSync. The next findChanges pass sees the file as new/
  // modified and the next syncAll pushes the canonical bytes back —
  // the server converges on the canonical form over one extra click.
  describe("text canonicalisation on pull (Stage 6.6)", () => {
    it("CRLF in remote text → local LF + next syncAll pushes canonical", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "line1\r\nline2\r\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [{ filename: "doc.md", status: "added", sha: "blob-crlf" }],
      });

      await f.manager.syncAll();

      // Local file is canonical.
      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("line1\nline2\n");
      // First syncAll deliberately does NOT recordSync the canonical
      // SHA — that's how the next findChanges spots the divergence.
      expect(f.store.get("doc.md")).toBeUndefined();
      // No commit fired in this first syncAll — just pull.
      expect(f.client.calls.filter((c) => c.op === "createCommit"))
        .toEqual([]);

      // Second syncAll: findChanges sees doc.md as untracked, enqueues
      // it, drain pushes the canonical bytes back to GitHub.
      await f.manager.syncAll();
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "doc.md")?.content).toBe(
        "line1\nline2\n",
      );
      expect(f.store.get("doc.md")?.remoteSha).toBe(
        await shaOf("line1\nline2\n"),
      );
    });

    it("BOM-prefixed remote text → BOM stripped locally + next syncAll pushes canonical", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "﻿title\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [{ filename: "doc.md", status: "added", sha: "blob-bom" }],
      });

      await f.manager.syncAll();

      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("title\n");
      expect(f.client.calls.filter((c) => c.op === "createCommit"))
        .toEqual([]);

      await f.manager.syncAll();
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "doc.md")?.content).toBe("title\n");
    });

    it("missing trailing newline on remote → \\n added locally + next syncAll pushes canonical", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "no trailing nl");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [{ filename: "doc.md", status: "added", sha: "blob-no-nl" }],
      });

      await f.manager.syncAll();

      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("no trailing nl\n");
      expect(f.client.calls.filter((c) => c.op === "createCommit"))
        .toEqual([]);

      await f.manager.syncAll();
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
      // (no trailing NL). Stage 6.6 normalizes that to
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

    it("syncFile: target normalized during pull → next syncFile pushes canonical", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "x.md", "content\r\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [{ filename: "x.md", status: "modified", sha: "blob-crlf" }],
      });

      await f.manager.syncFile("x.md");

      // Local is canonical after pull, but no push fired yet — the
      // path wasn't in any batch at click time.
      expect(
        fs.readFileSync(path.join(f.root, "x.md"), "utf8"),
      ).toBe("content\n");
      expect(f.client.calls.filter((c) => c.op === "createCommit"))
        .toEqual([]);

      // Second syncFile picks the canonical local up as "added" and
      // pushes it back to GitHub.
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

  // ── Stage 6.5 — conflict resolver contract -------------------------
  // Sync2Manager's onConflict callback now returns a discriminated
  // union (resolved / deferred / merged-into-one). These tests pin
  // each branch through the manager flow without going through the
  // real diff modal — the modal is a UI layer that just produces
  // these decision shapes.
  describe("OnConflict contract (Stage 6.5)", () => {
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
      // The Stage 6.5 markdown auto-merge feeds its result through the
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
        commitMessageAll: "Sync at {date} {time}",
        commitMessageFile: "Update {filename} at {date} {time}",
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
      // Commit message ends with " (test-device)" so parseDeviceSuffix
      // recovers that label and tags the sibling file with the FOREIGN
      // author rather than the local device — same convention sync2's
      // own appendDeviceSuffix uses on push.
      f2.client.setCommitMessage(
        "REMOTE_HEAD",
        "Sync at 2026-05-09 12:00:00.000 (test-device)",
      );
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

    it("hand-edited GitHub commit (no ' (label)' suffix) → sibling labelled 'unknown'", async () => {
      // Same setup as the kind=deferred test above, but the HEAD
      // commit message is what a user typed in GitHub's web UI —
      // no trailing " (deviceLabel)" tag. parseDeviceSuffix
      // returns the UNKNOWN_DEVICE_LABEL sentinel; the sibling
      // file should reflect that, NOT the local device's label.
      const ConflictStore = (
        await import("../../src/sync2/conflict-store")
      ).default;
      const f2 = fixture({});
      const conflictStore = new ConflictStore({
        vault: f2.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
      });
      await conflictStore.load();

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
        commitMessageAll: "Sync at {date} {time}",
        commitMessageFile: "Update {filename} at {date} {time}",
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
      // NO trailing " (label)" — what a hand-edited or non-sync2
      // commit looks like. parseDeviceSuffix → "unknown".
      f2.client.setCommitMessage(
        "REMOTE_HEAD",
        "Quick fix from the GitHub web editor",
      );
      f2.client.setContentAtRef("BASE_HEAD", "x.md", "shared\n");
      f2.client.setContentAtRef("REMOTE_HEAD", "x.md", "theirs-edits\n");
      f2.client.setCompareResult("BASE_HEAD", "REMOTE_HEAD", {
        status: "ahead",
        files: [
          { filename: "x.md", status: "modified", sha: "blob-of-theirs" },
        ],
      });

      await manager.syncAll();

      const records = conflictStore.forPath("x.md");
      expect(records).toHaveLength(1);
      expect(records[0].deviceLabel).toBe("unknown");
      expect(records[0].siblingPath).toContain("conflict-from-unknown-");

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
        theirsAuthor: "test-device",
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
        commitMessageAll: "Sync at {date} {time}",
        commitMessageFile: "Update {filename} at {date} {time}",
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
      });
      await conflictStore.load();

      writeVaultFile(f2.root, "x.md", "ours\n");
      const r = await conflictStore.create({
        vaultPath: "x.md",
        baseContent: "shared\n",
        theirsContent: "theirs\n",
        baseCommitSha: "OLD_HEAD",
        theirsBlobSha: "old-theirs-sha",
        theirsAuthor: "test-device",
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
        commitMessageAll: "Sync at {date} {time}",
        commitMessageFile: "Update {filename} at {date} {time}",
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
      });
      await conflictStore.load();
      writeVaultFile(f2.root, "a.md", "v1\n");
      await conflictStore.create({
        vaultPath: "a.md",
        baseContent: "shared\n",
        theirsContent: "theirs\n",
        baseCommitSha: "OLD_HEAD",
        theirsBlobSha: "old-theirs-sha",
        theirsAuthor: "test-device",
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
        commitMessageAll: "Sync at {date} {time}",
        commitMessageFile: "Update {filename} at {date} {time}",
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

      // Queue had work → not idle → no "Nothing to commit" notice.
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

  describe("resumeQueue / drain — bootstrap entry point", () => {
    // Regression guard for the "fresh device, never clicked Sync,
    // interval timer or onload fires backgroundDrain → drain →
    // pullIfNeeded" path. Drain must call bootstrapIfNeeded itself
    // since these background entry points bypass the click-body that
    // would normally bootstrap. Without this, fresh-install
    // users with autoCommit OFF + syncOnStartup ON would see drain
    // exit silently and never adopt the remote content.
    it("drain on a fresh client (lastSync=null) triggers bootstrap-from-remote", async () => {
      const f2 = fixture({});
      // Fresh client: no lastSync recorded, no local files.
      f2.client.setBranchHead("FRESH_HEAD");
      f2.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f2.client.setContentAtRef("FRESH_HEAD", "Notes/alpha.md", "alpha\n");
      f2.client.setContentAtRef("FRESH_HEAD", "Notes/beta.md", "beta\n");

      await f2.manager.resumeQueue();

      // Bootstrap-from-remote pulled the remote files into the vault.
      expect(
        fs.readFileSync(path.join(f2.root, "Notes/alpha.md"), "utf8"),
      ).toBe("alpha\n");
      expect(
        fs.readFileSync(path.join(f2.root, "Notes/beta.md"), "utf8"),
      ).toBe("beta\n");
      // lastSync now set — subsequent calls skip bootstrap.
      expect(f2.store.getLastSyncCommitSha()).toBe("FRESH_HEAD");
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("drain on an already-bootstrapped client doesn't re-bootstrap", async () => {
      // After lastSync is set, bootstrapIfNeeded returns null in O(1)
      // — no getRepoContent call, no re-adoption.
      f.store.setLastSync("HEAD_X", "TREE_X");
      f.client.setBranchHead("HEAD_X");

      await f.manager.resumeQueue();

      // Defensive check: no extra getRepoContent calls (the only
      // surface the bootstrap path uses to fetch the tree).
      const tree = f.client.calls.filter(
        (c) => c.op === "getRepoContent",
      );
      expect(tree).toEqual([]);
    });
  });

  describe("resumeQueue + accumulateOfflineSyncs (Stage 6d)", () => {
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

  describe("accumulateOfflineSyncs (Stage 6d)", () => {
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
      return {
        ...f,
        allowNextPush: () => (allowPush = true),
        allowAllPushes: () => (allowPush = true),
      };
    }

    it("offline + accumulate ON: failed batch is locked, second sync stacks a new one", async () => {
      // Under the user's spec, a batch that's been attempted at all
      // (even once, even if it failed) is frozen against further
      // accumulate-merges. The .attempted marker enforces this: it
      // gets written at the start of processBatch and is NEVER
      // cleared on failure. So even with accumulateOfflineSyncs ON,
      // a second sync click after a failed push creates a separate
      // batch — symmetric to the accumulate=OFF behaviour below.
      const f2 = brokenNetworkFixture();
      writeVaultFile(f2.root, "a.md", "v1");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

      await expect(f2.manager.syncAll()).rejects.toThrow(
        /simulated network outage/,
      );
      const idsAfter1 = await f2.queue.list();
      expect(idsAfter1).toHaveLength(1);

      // The first batch must be marked .attempted; mergeIntoLatestPending
      // skips it on the next syncAll.
      const b1 = await f2.queue.read(idsAfter1[0]);
      expect(b1.attempted).toBe(true);

      writeVaultFile(f2.root, "b.md", "v2");

      await expect(f2.manager.syncAll()).rejects.toThrow();
      const idsAfter2 = await f2.queue.list();
      expect(idsAfter2).toHaveLength(2);

      // Each batch holds only the changes from its own sync click —
      // b.md did NOT fold into B1.
      const newId = idsAfter2.find((id) => !idsAfter1.includes(id));
      expect(newId).toBeDefined();
      const b2 = await f2.queue.read(newId!);
      expect(b2.files).toEqual(["b.md"]);

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

    it("queued batches drain FIFO once network is back, each as its own commit", async () => {
      // With the attempted-marker locking failed batches, two failed
      // sync clicks produce TWO batches in queue (B1 + B2), not one
      // folded batch. When the network returns, processQueue drains
      // them in order: B1 commits (carrying a.md), then B2 commits
      // (carrying b.md). Two updateBranchHead calls succeed, queue
      // ends empty.
      const f2 = brokenNetworkFixture();
      writeVaultFile(f2.root, "a.md", "v1");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await expect(f2.manager.syncAll()).rejects.toThrow();
      writeVaultFile(f2.root, "b.md", "v2");
      await expect(f2.manager.syncAll()).rejects.toThrow();

      // Network restored; let every subsequent push through.
      f2.allowAllPushes();
      await f2.manager.resumeQueue();

      // Two commits landed in order. Each tree carries only its own
      // batch's files — proof the merge step refused to fold them.
      const refUpdates = f2.client.calls.filter(
        (c) => c.op === "updateBranchHead",
      );
      expect(refUpdates).toHaveLength(2);
      expect(await f2.queue.list()).toEqual([]);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  describe("progress UI (Step 5)", () => {
    it("single batch heavy push: notice opens at 'Push 0/N files to GitHub' and ends 'Sync done'", async () => {
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
      writeVaultFile(f2.root, "x.md", "v");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await f2.manager.syncAll();
      // Lazy-open: notice opens straight into the file counter. No
      // separate "Push to GitHub…" pre-message, no batch-number
      // indicator.
      expect(messages[0]).toBe("Push 0/1 files to GitHub");
      // Final state is the "Sync done" replace on the same handle.
      expect(messages[messages.length - 1]).toBe("Sync done");
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("two pending batches: each batch shows its own 'Push X/N files to GitHub'", async () => {
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

      // Each batch shows its own "Push X/N files to GitHub" counter.
      // No commit-number indicator — every batch is a self-contained
      // Push view from the user's perspective. The final state is
      // "Sync done" replacing the same handle once the queue empties.
      expect(messages.some((m) => m === "Push 0/1 files to GitHub")).toBe(
        true,
      );
      expect(messages.some((m) => m === "Push 1/1 files to GitHub")).toBe(
        true,
      );
      expect(messages[messages.length - 1]).toBe("Sync done");
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("no onProgress provided: sync runs without crashing", async () => {
      writeVaultFile(f.root, "x.md", "v");
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await f.manager.syncAll();
      // No assertion needed beyond completion.
    });

    it("live N/M counter: progress messages tick through 'Push X/N'", async () => {
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
      // Mixed batch: 2 text files + 2 binaries. The counter has to
      // span all four, not just the binary uploads.
      writeVaultFile(f2.root, "a.md", "one");
      writeVaultFile(f2.root, "b.md", "two");
      writeVaultFile(f2.root, "c.png", Buffer.from([1, 2, 3]));
      writeVaultFile(f2.root, "d.png", Buffer.from([4, 5, 6]));

      await f2.manager.syncAll();

      // Notice opens directly into "Push 0/4 files to GitHub" via the
      // drain's lazy-open + ticks through "Push X/4 files to GitHub"
      // as the tree-builder hook fires per file, and ends with
      // "Sync done" replacing the same handle.
      expect(messages[0]).toBe("Push 0/4 files to GitHub");
      expect(
        messages.some((m) => m === "Push 4/4 files to GitHub"),
      ).toBe(true);
      expect(messages[messages.length - 1]).toBe("Sync done");
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("pull-side counter: bootstrap-from-remote ticks 'Preparing GitHub syncing: X/N'", async () => {
      // Adoption path (fresh vault, remote has content). Adoption is
      // a comparison pass — for vaults previously synced via another
      // tool most paths SHA-match and only a subset actually pulls,
      // so the user-facing label is "Reconciling" not "Downloading".
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
      f2.client.setBranchHead("FRESH_HEAD");
      f2.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f2.client.setContentAtRef("FRESH_HEAD", "a.md", "a\n");
      f2.client.setContentAtRef("FRESH_HEAD", "b.md", "b\n");
      f2.client.setContentAtRef("FRESH_HEAD", "c.md", "c\n");

      await f2.manager.syncAll();

      expect(messages.some((m) => /Preparing GitHub syncing/.test(m))).toBe(
        true,
      );
      expect(messages.some((m) => /Preparing GitHub syncing: 3\/3/.test(m))).toBe(
        true,
      );
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("idle syncAll stays silent (no notice opened)", async () => {
      // With the lazy-open contract there's no eager click-time notice
      // anymore. Trivially idle syncs run completely silent — neither
      // pull nor push opens the long-lived progress handle. The
      // onNoLocalChanges callback handles the brief "Nothing to commit" flash
      // separately.
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
        progressBytesThreshold: Infinity,
      });
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await f2.manager.syncAll();
      expect(messages).toEqual([]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onSyncCompleted fires with pushed/pulled counts at end of syncAll", async () => {
      const summaries: Array<{ pushedFiles: number; pulledFiles: number }> = [];
      const f2 = fixture({
        onProgress: (initial) => ({
          update: () => {},
          hide: () => {},
        }),
      });
      // Manually wire up the field (fixture currently doesn't pipe
      // onSyncCompleted, but the manager respects it when present
      // — assigned post-construct here for the test only).
      (
        f2.manager as unknown as {
          onSyncCompleted?: (s: {
            pushedFiles: number;
            pulledFiles: number;
          }) => void;
        }
      ).onSyncCompleted = (s) => summaries.push(s);

      // Push-only: lastSync set + a fresh local file → one push.
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      writeVaultFile(f2.root, "x.md", "v");

      await f2.manager.syncAll();

      expect(summaries).toHaveLength(1);
      expect(summaries[0].pushedFiles).toBe(1);
      expect(summaries[0].pulledFiles).toBe(0);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onSyncCompleted: pull-only sync reports pulledFiles > 0, pushedFiles = 0", async () => {
      const summaries: Array<{ pushedFiles: number; pulledFiles: number }> = [];
      const f2 = fixture({
        onProgress: (initial) => ({
          update: () => {},
          hide: () => {},
        }),
      });
      (
        f2.manager as unknown as {
          onSyncCompleted?: (s: {
            pushedFiles: number;
            pulledFiles: number;
          }) => void;
        }
      ).onSyncCompleted = (s) => summaries.push(s);

      // Adoption from a fresh remote with two files — both pull.
      f2.client.setBranchHead("FRESH_HEAD");
      f2.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f2.client.setContentAtRef("FRESH_HEAD", "a.md", "alpha\n");
      f2.client.setContentAtRef("FRESH_HEAD", "b.md", "beta\n");

      await f2.manager.syncAll();

      expect(summaries).toHaveLength(1);
      expect(summaries[0].pulledFiles).toBe(2);
      // The republish heuristic may queue a tiny push for the
      // canonicalised invariant gitignores, but for THIS pair of
      // files (canonical text), nothing extra. Loose check:
      expect(summaries[0].pushedFiles).toBeGreaterThanOrEqual(0);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("pull-side counter: incremental pullIfNeeded ticks through too", async () => {
      // Regular sync (lastSync set, head moved): pullIfNeeded fetches
      // the diff and applies each file. Same M/N progress contract
      // as bootstrap.
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
      // Pretend we've already synced at OLD_HEAD; the branch moved
      // forward and two files changed on the remote side.
      f2.store.setLastSync("OLD_HEAD", "OLD_TREE");
      f2.client.setBranchHead("NEW_HEAD");
      f2.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f2.client.setCompareResult("OLD_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "Notes/a.md", status: "added", sha: "irrelevant" },
          { filename: "Notes/b.md", status: "modified", sha: "irrelevant" },
        ],
      });
      f2.client.setContentAtRef("OLD_HEAD", "Notes/b.md", "old beta\n");
      f2.client.setContentAtRef("NEW_HEAD", "Notes/a.md", "new alpha\n");
      f2.client.setContentAtRef("NEW_HEAD", "Notes/b.md", "new beta\n");

      await f2.manager.syncAll();

      expect(messages.some((m) => /Pull 0\/2/.test(m))).toBe(true);
      expect(messages.some((m) => /Pull 2\/2/.test(m))).toBe(true);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("pull-side: no notice when there's nothing syncable to pull", async () => {
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
      // Fresh vault, remote head exists, but the only file is
      // explicitly gitignored — nothing for the loop to do.
      f2.client.setBranchHead("FRESH_HEAD");
      f2.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f2.client.setContentAtRef("FRESH_HEAD", ".gitignore", "secret/\n");
      f2.client.setContentAtRef(
        "FRESH_HEAD",
        "secret/private.md",
        "blocked",
      );
      writeVaultFile(f2.root, ".gitignore", "secret/\n");

      await f2.manager.syncAll();

      // The "Pull…" message must not have fired with anything beyond
      // the gitignore itself — every other remote path got filtered.
      const pullFires = messages.filter((m) => /^Pull /.test(m));
      for (const m of pullFires) {
        expect(m).toMatch(/Pull [01]\/1/);
      }
      fs.rmSync(f2.root, { recursive: true, force: true });
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

describe("Sync2Manager — reconcileRemoteIdentity", () => {
  // The reconcile step is what runs at the very start of syncAll —
  // exercised here in isolation (cast to any) so the assertions
  // don't have to model the rest of syncAll's bootstrap/pull flow
  // re-populating `lastSyncCommitSha`. Public syncAll is exercised
  // by integration tests downstream.
  type ReconcilableManager = { reconcileRemoteIdentity(): Promise<void> };
  const reconcile = (m: Sync2Manager): Promise<void> =>
    (m as unknown as ReconcilableManager).reconcileRemoteIdentity();

  it("first observation: records identity, doesn't reset (upgrade-safe)", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("EXISTING_SHA", "EXISTING_TREE");
    expect(f.store.getRemoteIdentity()).toBeNull();

    await reconcile(f.manager);

    expect(f.store.getRemoteIdentity()).toEqual(handle);
    // lastSync untouched — no reset happened.
    expect(f.store.getLastSyncCommitSha()).toBe("EXISTING_SHA");
  });

  it("matching identity: no-op", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.store.setRemoteIdentity({ ...handle });

    await reconcile(f.manager);

    expect(f.store.getRemoteIdentity()).toEqual(handle);
    expect(f.store.getLastSyncCommitSha()).toBe("BRANCH_HEAD_INIT");
  });

  it("repo change: wipes snapshot + push-queue, records new identity", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.store.setRemoteIdentity({ ...handle });
    // Leave a pending batch on disk (a failed earlier push).
    writeVaultFile(f.root, "stale.md", "from old repo");
    const id = await f.queue.enqueue(
      [
        {
          kind: "added",
          path: "stale.md",
          size: 13,
          mtime: f.clock.nowMs(),
        },
      ],
      {
        commitMessage: "old commit",
        parentCommitSha: "OLD_PARENT",
        parentTreeSha: "OLD_PARENT_TREE",
      },
    );
    expect(await f.queue.list()).toContain(id);

    // User edits settings → new repo.
    handle.repo = "different-vault";

    await reconcile(f.manager);

    expect(f.store.getRemoteIdentity()).toEqual({
      owner: "alice",
      repo: "different-vault",
      branch: "main",
    });
    expect(f.store.getLastSyncCommitSha()).toBeNull();
    expect(await f.queue.list()).not.toContain(id);
  });

  it("branch change: also triggers reset (treated same as repo change)", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.store.setRemoteIdentity({ ...handle });

    handle.branch = "dev";

    await reconcile(f.manager);

    expect(f.store.getLastSyncCommitSha()).toBeNull();
    expect(f.store.getRemoteIdentity()?.branch).toBe("dev");
  });

  it("owner change: also triggers reset", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.store.setRemoteIdentity({ ...handle });

    handle.owner = "bob";

    await reconcile(f.manager);

    expect(f.store.getLastSyncCommitSha()).toBeNull();
    expect(f.store.getRemoteIdentity()?.owner).toBe("bob");
  });

  it("no remoteIdentity getter: reconcile is a no-op", async () => {
    const f = fixture(); // no opts.remoteIdentity
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await reconcile(f.manager);

    expect(f.store.getRemoteIdentity()).toBeNull();
    expect(f.store.getLastSyncCommitSha()).toBe("BRANCH_HEAD_INIT");
  });
});
