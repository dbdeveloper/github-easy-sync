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
import { Vault } from "../../mock-obsidian";
import { FileChange } from "../../src/sync2/types";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture(): {
  root: string;
  vault: Vault;
  queue: PushQueue;
  queueRoot: string;
  clock: { tick: () => Date; set: (d: Date) => void };
} {
  const root = path.join(
    os.tmpdir(),
    `push-queue-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  let current = new Date("2026-05-03T09:38:23.000Z");
  const clock = {
    tick: () => {
      const d = new Date(current);
      current = new Date(current.getTime() + 1000);
      return d;
    },
    set: (d: Date) => {
      current = d;
    },
  };
  const queue = new PushQueue({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => clock.tick(),
  });
  const queueRoot = path.join(
    root,
    CONFIG_DIR,
    "plugins",
    SELF_PLUGIN_ID,
    ".push-queue",
  );
  return { root, vault, queue, queueRoot, clock };
}

function writeVaultFile(root: string, rel: string, content: string): void {
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

const MOD = (p: string, prevSha = "old"): FileChange => ({
  kind: "modified",
  path: p,
  size: 0,
  mtime: 0,
  previousRemoteSha: prevSha,
});

const DEL = (p: string, prevSha = "old"): FileChange => ({
  kind: "deleted",
  path: p,
  previousRemoteSha: prevSha,
});

describe("PushQueue", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  describe("enqueue + read", () => {
    it("creates a batch directory with vault/, .meta.json, and the file", async () => {
      writeVaultFile(f.root, "Notes/x.md", "hello\n");
      const id = await f.queue.enqueue([ADD("Notes/x.md")], {
        commitMessage: "first",
        parentCommitSha: "abc123",
        parentTreeSha: "def456",
      });
      expect(id).toMatch(/^\d{17}$/);

      const batchDir = path.join(f.queueRoot, id);
      expect(fs.existsSync(batchDir)).toBe(true);
      expect(fs.existsSync(path.join(batchDir, ".meta.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(batchDir, "vault", "Notes", "x.md")),
      ).toBe(true);
      expect(
        fs.readFileSync(path.join(batchDir, "vault", "Notes", "x.md"), "utf8"),
      ).toBe("hello\n");
    });

    it("read() returns the QueueBatch shape", async () => {
      writeVaultFile(f.root, "x.md", "v1\n");
      const id = await f.queue.enqueue(
        [ADD("x.md"), DEL("Folder/old.md")],
        {
          commitMessage: "msg",
          parentCommitSha: "abc",
          parentTreeSha: "def",
        },
      );

      const batch = await f.queue.read(id);
      expect(batch).toMatchObject({
        id,
        inProgress: false,
        commitMessage: "msg",
        parentCommitSha: "abc",
        parentTreeSha: "def",
        files: ["x.md"],
        deletions: ["Folder/old.md"],
      });
    });

    it("handles binary files via writeBinary", async () => {
      // .png — non-text by hasTextExtension
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const abs = path.join(f.root, "img.png");
      fs.writeFileSync(abs, bytes);

      const id = await f.queue.enqueue([ADD("img.png")], {
        commitMessage: "img",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "img.png"),
      );
      expect(stored.equals(bytes)).toBe(true);
    });

    it("handles deletions-only batch (no vault/ files, just deleted-paths.txt)", async () => {
      const id = await f.queue.enqueue(
        [DEL("a.md"), DEL("b.md")],
        {
          commitMessage: "cleanup",
          parentCommitSha: null,
          parentTreeSha: null,
        },
      );
      const batch = await f.queue.read(id);
      expect(batch.files).toEqual([]);
      expect(batch.deletions.sort()).toEqual(["a.md", "b.md"]);
    });

    it("preserves nested directory structure", async () => {
      writeVaultFile(f.root, "Folder/Deep/Nested/note.md", "z\n");
      const id = await f.queue.enqueue(
        [ADD("Folder/Deep/Nested/note.md")],
        {
          commitMessage: "deep",
          parentCommitSha: null,
          parentTreeSha: null,
        },
      );
      const stored = fs.readFileSync(
        path.join(
          f.queueRoot,
          id,
          "vault",
          "Folder",
          "Deep",
          "Nested",
          "note.md",
        ),
        "utf8",
      );
      expect(stored).toBe("z\n");
    });
  });

  describe("list", () => {
    it("returns empty when queue dir doesn't exist", async () => {
      expect(await f.queue.list()).toEqual([]);
    });

    it("returns IDs in chronological (lexicographic) order", async () => {
      writeVaultFile(f.root, "a.md", "1");
      writeVaultFile(f.root, "b.md", "2");
      writeVaultFile(f.root, "c.md", "3");
      const id1 = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "1",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      const id2 = await f.queue.enqueue([ADD("b.md")], {
        commitMessage: "2",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      const id3 = await f.queue.enqueue([ADD("c.md")], {
        commitMessage: "3",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      expect(await f.queue.list()).toEqual([id1, id2, id3]);
    });

    it("ignores stray non-batch entries inside the queue root", async () => {
      writeVaultFile(f.root, "a.md", "1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "msg",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      // Drop a stray dotfile alongside the batch.
      fs.writeFileSync(path.join(f.queueRoot, ".DS_Store"), "");
      fs.mkdirSync(path.join(f.queueRoot, "scratch"), { recursive: true });
      expect(await f.queue.list()).toEqual([id]);
    });

    it("colliding timestamps get bumped to the next millisecond", async () => {
      writeVaultFile(f.root, "a.md", "1");
      writeVaultFile(f.root, "b.md", "2");
      // Lock the clock so consecutive enqueues see the same now()
      // value; PushQueue should resolve the conflict by stepping.
      const fixed = new Date("2026-05-03T09:38:23.500Z");
      f.clock.set(fixed);
      const id1 = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "1",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      f.clock.set(fixed);
      const id2 = await f.queue.enqueue([ADD("b.md")], {
        commitMessage: "2",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      expect(id1).not.toBe(id2);
      expect(id2 > id1).toBe(true);
    });
  });

  describe("markInProgress / clearInProgress", () => {
    it("marker survives across PushQueue instances", async () => {
      writeVaultFile(f.root, "a.md", "1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      await f.queue.markInProgress(id);
      // Fresh PushQueue using the same vault sees the marker.
      const other = new PushQueue({
        vault: f.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
      });
      const batch = await other.read(id);
      expect(batch.inProgress).toBe(true);
    });

    it("clearInProgress removes the marker; double-clear is safe", async () => {
      writeVaultFile(f.root, "a.md", "1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      await f.queue.markInProgress(id);
      await f.queue.clearInProgress(id);
      await f.queue.clearInProgress(id); // no-op, no throw
      const batch = await f.queue.read(id);
      expect(batch.inProgress).toBe(false);
    });
  });

  describe("delete", () => {
    it("removes the batch directory and everything inside", async () => {
      writeVaultFile(f.root, "Folder/x.md", "1");
      const id = await f.queue.enqueue([ADD("Folder/x.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      expect(fs.existsSync(path.join(f.queueRoot, id))).toBe(true);
      await f.queue.delete(id);
      expect(fs.existsSync(path.join(f.queueRoot, id))).toBe(false);
      expect(await f.queue.list()).toEqual([]);
    });

    it("deleting a missing batch is a no-op", async () => {
      await expect(f.queue.delete("doesnotexist")).resolves.not.toThrow();
    });
  });

  describe("mergeIntoLatestPending", () => {
    it("returns null when there is no pending batch", async () => {
      expect(await f.queue.mergeIntoLatestPending([ADD("a.md")])).toBeNull();
    });

    it("merges new uploads into the latest pending batch", async () => {
      writeVaultFile(f.root, "a.md", "v1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "first",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      writeVaultFile(f.root, "b.md", "fresh");
      const target = await f.queue.mergeIntoLatestPending([ADD("b.md")]);
      expect(target).toBe(id);

      const batch = await f.queue.read(id);
      expect(batch.files.sort()).toEqual(["a.md", "b.md"]);
    });

    it("re-snapshots a path on overwrite", async () => {
      writeVaultFile(f.root, "a.md", "v1\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "first",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      writeVaultFile(f.root, "a.md", "v2\n");
      await f.queue.mergeIntoLatestPending([MOD("a.md", "old")]);

      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(stored).toBe("v2\n");
    });

    it("a deletion overrides a prior upload of the same path", async () => {
      writeVaultFile(f.root, "a.md", "v1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "first",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      await f.queue.mergeIntoLatestPending([DEL("a.md")]);

      const batch = await f.queue.read(id);
      expect(batch.files).toEqual([]);
      expect(batch.deletions).toEqual(["a.md"]);
      expect(
        fs.existsSync(path.join(f.queueRoot, id, "vault", "a.md")),
      ).toBe(false);
    });

    it("an upload overrides a prior deletion of the same path", async () => {
      writeVaultFile(f.root, "a.md", "v1");
      const id = await f.queue.enqueue([DEL("a.md")], {
        commitMessage: "first",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      writeVaultFile(f.root, "a.md", "resurrected");
      await f.queue.mergeIntoLatestPending([ADD("a.md")]);

      const batch = await f.queue.read(id);
      expect(batch.files).toEqual(["a.md"]);
      expect(batch.deletions).toEqual([]);
    });

    it("skips in-progress batches and returns null if all are in-progress", async () => {
      writeVaultFile(f.root, "a.md", "v1");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });
      await f.queue.markInProgress(id);
      writeVaultFile(f.root, "b.md", "v2");
      const target = await f.queue.mergeIntoLatestPending([ADD("b.md")]);
      expect(target).toBeNull();
    });
  });

  describe("overwriteFile", () => {
    it("replaces a file's content inside an existing batch", async () => {
      writeVaultFile(f.root, "a.md", "v1\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const newContent = new TextEncoder().encode("merged content\n")
        .buffer as ArrayBuffer;
      await f.queue.overwriteFile(id, "a.md", newContent);

      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(stored).toBe("merged content\n");
    });

    it("creates intermediate directories when overwriting a deeply nested file", async () => {
      writeVaultFile(f.root, "a.md", "v1\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const buf = new TextEncoder().encode("deep\n").buffer as ArrayBuffer;
      await f.queue.overwriteFile(id, "Folder/Deep/Nested/note.md", buf);

      const stored = fs.readFileSync(
        path.join(
          f.queueRoot,
          id,
          "vault",
          "Folder",
          "Deep",
          "Nested",
          "note.md",
        ),
        "utf8",
      );
      expect(stored).toBe("deep\n");
    });
  });

  // ── Stage 6.6 — text canonicalisation -------------------------------
  // Push side: any non-canonical text file (CRLF / BOM / missing
  // trailing-NL) gets normalized into the snapshot AND written back to
  // the live vault file. Binaries are byte-exact regardless of byte
  // patterns that might look like CRLF. overwriteFile normalizes the
  // text input as a safety net for cascade-rebase callers.
  describe("text canonicalisation (Stage 6.6)", () => {
    it("CRLF in vault → snapshot has LF, vault file rewritten to LF", async () => {
      writeVaultFile(f.root, "a.md", "first\r\nsecond\r\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      // Snapshot is canonical.
      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(snapshot).toBe("first\nsecond\n");

      // Live vault file is also canonical (write-back invariant).
      const live = fs.readFileSync(path.join(f.root, "a.md"), "utf8");
      expect(live).toBe("first\nsecond\n");
    });

    it("UTF-8 BOM at start → stripped from both snapshot and vault", async () => {
      // The BOM as raw bytes EF BB BF.
      const bytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("title\n", "utf-8"),
      ]);
      const abs = path.join(f.root, "doc.md");
      fs.writeFileSync(abs, bytes);

      const id = await f.queue.enqueue([ADD("doc.md")], {
        commitMessage: "bom",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "doc.md"),
      );
      expect(snapshot.equals(Buffer.from("title\n", "utf-8"))).toBe(true);

      const live = fs.readFileSync(abs);
      expect(live.equals(Buffer.from("title\n", "utf-8"))).toBe(true);
    });

    it("missing trailing newline → added in both snapshot and vault", async () => {
      writeVaultFile(f.root, "a.md", "no trailing nl");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(snapshot).toBe("no trailing nl\n");

      const live = fs.readFileSync(path.join(f.root, "a.md"), "utf8");
      expect(live).toBe("no trailing nl\n");
    });

    it("empty file stays empty (no \\n added)", async () => {
      writeVaultFile(f.root, "empty.md", "");
      const id = await f.queue.enqueue([ADD("empty.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "empty.md"),
        "utf8",
      );
      expect(snapshot).toBe("");

      const live = fs.readFileSync(path.join(f.root, "empty.md"), "utf8");
      expect(live).toBe("");
    });

    it("already-canonical text → vault file is NOT rewritten (mtime preserved)", async () => {
      // Skip the rewrite when nothing changes — preserves mtime so
      // ChangeDetector's stat-cache shortcut keeps working.
      writeVaultFile(f.root, "a.md", "clean\n");
      const abs = path.join(f.root, "a.md");
      const mtimeBefore = fs.statSync(abs).mtimeMs;

      // Wait a tick so a stray write would visibly bump mtime.
      await new Promise((r) => setTimeout(r, 25));

      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const mtimeAfter = fs.statSync(abs).mtimeMs;
      expect(mtimeAfter).toBe(mtimeBefore);

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(snapshot).toBe("clean\n");
    });

    it("binary file with CRLF-like bytes is byte-exact, not normalized", async () => {
      // Binary file (PNG-extension) whose contents happen to contain
      // 0x0D 0x0A pairs. Those are bytes, not line endings — must NOT
      // be touched by normalize.
      const bytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, // PNG magic
        0x0d, 0x0a,             // CR LF — incidental byte pair
        0x1a, 0x0a,             // EOF marker, then LF byte
        0xef, 0xbb, 0xbf,       // BOM bytes mid-stream
        0x00, 0x01, 0x02, 0x03, // body
      ]);
      const abs = path.join(f.root, "img.png");
      fs.writeFileSync(abs, bytes);

      const id = await f.queue.enqueue([ADD("img.png")], {
        commitMessage: "bin",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "img.png"),
      );
      expect(snapshot.equals(bytes)).toBe(true);

      // Live file untouched.
      const live = fs.readFileSync(abs);
      expect(live.equals(bytes)).toBe(true);
    });

    it("mergeIntoLatestPending normalizes the re-snapshotted text too", async () => {
      writeVaultFile(f.root, "a.md", "v1\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "first",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      // User pastes CRLF into the file then triggers Sync (offline
      // accumulate path). Snapshot of v2 must be canonical.
      writeVaultFile(f.root, "a.md", "v2-line1\r\nv2-line2\r\n");
      await f.queue.mergeIntoLatestPending([MOD("a.md", "old")]);

      const snapshot = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(snapshot).toBe("v2-line1\nv2-line2\n");

      const live = fs.readFileSync(path.join(f.root, "a.md"), "utf8");
      expect(live).toBe("v2-line1\nv2-line2\n");
    });

    it("overwriteFile normalizes non-canonical text input (cascade-rebase safety net)", async () => {
      writeVaultFile(f.root, "a.md", "seed\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      // Caller passes content with CRLF + BOM + no trailing NL —
      // overwriteFile normalizes before storing in the snapshot.
      const dirty = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("merged-line-1\r\nmerged-line-2", "utf-8"),
      ]);
      const ab = dirty.buffer.slice(
        dirty.byteOffset,
        dirty.byteOffset + dirty.byteLength,
      ) as ArrayBuffer;
      await f.queue.overwriteFile(id, "a.md", ab);

      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "a.md"),
        "utf8",
      );
      expect(stored).toBe("merged-line-1\nmerged-line-2\n");
    });

    it("overwriteFile leaves binary content byte-exact even with CRLF-like bytes", async () => {
      writeVaultFile(f.root, "a.md", "seed\n");
      const id = await f.queue.enqueue([ADD("a.md")], {
        commitMessage: "x",
        parentCommitSha: null,
        parentTreeSha: null,
      });

      const bytes = Buffer.from([0x89, 0x0d, 0x0a, 0xef, 0xbb, 0xbf, 0xff]);
      const ab = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      await f.queue.overwriteFile(id, "img.png", ab);

      const stored = fs.readFileSync(
        path.join(f.queueRoot, id, "vault", "img.png"),
      );
      expect(stored.equals(bytes)).toBe(true);
    });
  });
});
