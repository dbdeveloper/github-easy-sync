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
import ConflictStore, {
  type CreateArgs,
} from "../../src/sync2/conflict-store";
import { ConflictWatcher } from "../../src/sync2/conflict-watcher";
import type { EvaluationResult } from "../../src/sync2/conflict-classifier";
import { Vault } from "../../mock-obsidian";

// Pseudo-merge ConflictWatcher tests (PSEUDO-MERGE-MODE.md, stage 4).
//
// Covers:
//   - Fast-path Set check (hasPending OR hasSibling) — miss skips evaluation
//   - Hit triggers evaluateConflictState, fires onResolution callback
//   - pause() blocks events; resume() re-enables
//   - Chain serialization: concurrent handle() calls don't race
//   - flush() awaits the in-flight queue
//   - start() is idempotent; stop() unsubscribes
//   - End-to-end: vault.fireEvent → watcher fires → store updates
//   - onError catches eval failures without poisoning the chain

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture(): {
  root: string;
  vault: Vault;
  store: ConflictStore;
  clock: { tick: () => number };
} {
  const root = path.join(
    os.tmpdir(),
    `conflict-watcher-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  let currentMs = Date.UTC(2026, 4, 8, 15, 30, 0, 0);
  const clock = {
    tick: () => {
      const t = currentMs;
      currentMs += 1000;
      return t;
    },
  };
  let counter = 0;
  const store = new ConflictStore({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => clock.tick(),
    idFactory: () =>
      `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`,
  });
  return { root, vault, store, clock };
}

function arr(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer.slice(0) as ArrayBuffer;
}

function writeVaultFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function baseArgs(over: Partial<CreateArgs> = {}): CreateArgs {
  return {
    vaultPath: "Notes/note.md",
    kind: "modify-vs-modify",
    theirsContent: arr("theirs\n"),
    theirsBlobSha: "t",
    oursBlobSha: "o",
    baseMtime: null,
    baseSize: null,
    baseSha: null,
    remoteDevice: "Phone",
    ...over,
  };
}

describe("ConflictWatcher", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  // ─── Fast-path Set check ────────────────────────────────────────────

  it("handle(): irrelevant path → skips evaluation entirely", async () => {
    await f.store.load();
    const results: EvaluationResult[] = [];
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      onResolution: (r) => {
        results.push(r);
      },
    });

    await watcher.handle("unrelated/file.md");
    await watcher.flush();

    expect(results).toEqual([]);
  });

  it("handle(): base path with active conflict → fires evaluation + onResolution", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    const results: EvaluationResult[] = [];
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      onResolution: (r) => {
        results.push(r);
      },
      now: () => 100,
    });

    // User deletes the sibling → case 1 trigger.
    fs.unlinkSync(path.join(f.root, rec.siblingPath));
    // Watcher gets notified about the sibling path (it was a known sibling).
    await watcher.handle(rec.siblingPath);
    await watcher.flush();

    expect(results.length).toBe(1);
    expect(results[0].recordsRemoved).toEqual([rec.id]);
    expect([...results[0].pathsResolved]).toEqual(["Notes/note.md"]);
  });

  it("handle(): sibling path → also triggers (fast-path includes siblings)", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    let fired = false;
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      onResolution: () => {
        fired = true;
      },
    });

    // No vault change — but we want to confirm the fast-path check
    // recognises sibling paths. Touch (but don't change) the sibling
    // so evaluate sees nothing to resolve; we just verify the path
    // was deemed relevant and evaluate ran.
    await watcher.handle(rec.siblingPath);
    await watcher.flush();

    expect(fired).toBe(true);
  });

  // ─── pause / resume ─────────────────────────────────────────────────

  it("pause(): handles are no-ops; resume() reactivates without queuing missed events", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    let count = 0;
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      onResolution: () => {
        count++;
      },
    });

    watcher.pause();
    fs.unlinkSync(path.join(f.root, rec.siblingPath));
    await watcher.handle(rec.siblingPath);
    await watcher.flush();
    expect(count).toBe(0); // paused → no eval
    // Record still indexed; the deletion wasn't observed.
    expect(f.store.get(rec.id)).toBeDefined();

    watcher.resume();
    // After resume, future events fire normally. But the previous
    // event isn't replayed — spec line ~125: "Obsidian events не
    // буферизуються; якщо обробник пасивний, події фактично
    // втрачаються". A subsequent sweep (drain-end / drain-start)
    // catches the missed state via full scan; we simulate that with
    // an explicit handle on the relevant path.
    await watcher.handle(rec.siblingPath);
    await watcher.flush();
    expect(count).toBe(1);
    expect(f.store.get(rec.id)).toBeUndefined();
  });

  it("isPaused() reflects current state", async () => {
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
    });
    expect(watcher.isPaused()).toBe(false);
    watcher.pause();
    expect(watcher.isPaused()).toBe(true);
    watcher.resume();
    expect(watcher.isPaused()).toBe(false);
  });

  // ─── Chain serialization ────────────────────────────────────────────

  it("concurrent handle() calls serialize through the chain (no parallel eval)", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    let inFlight = 0;
    let maxInFlight = 0;
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      onResolution: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield once so any "parallel" task gets a chance to start.
        await Promise.resolve();
        inFlight--;
      },
    });

    fs.unlinkSync(path.join(f.root, rec.siblingPath));
    // Fire 5 concurrent handle() calls — without serialization, all
    // five would interleave their await Promise.resolve() and push
    // maxInFlight to 5.
    await Promise.all([
      watcher.handle(rec.siblingPath),
      watcher.handle(rec.siblingPath),
      watcher.handle(rec.siblingPath),
      watcher.handle(rec.siblingPath),
      watcher.handle(rec.siblingPath),
    ]);

    expect(maxInFlight).toBe(1); // strict serialization
  });

  it("queued tasks re-check relevance — already-resolved path silently skips", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    let evalCount = 0;
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      onResolution: () => {
        evalCount++;
      },
    });

    fs.unlinkSync(path.join(f.root, rec.siblingPath));
    // Two events for the same now-deleted sibling. First eval
    // resolves the record. Second eval's re-check sees the record
    // is gone → skips evaluation (no second onResolution).
    await Promise.all([
      watcher.handle(rec.siblingPath),
      watcher.handle(rec.siblingPath),
    ]);

    expect(evalCount).toBe(1);
  });

  // ─── start / stop ───────────────────────────────────────────────────

  it("start() registers delete/modify/rename listeners", async () => {
    await f.store.load();
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
    });
    expect(
      (f.vault as unknown as { listeners: unknown[] }).listeners.length,
    ).toBe(0);
    watcher.start();
    const subscribed = (
      f.vault as unknown as {
        listeners: { event: string }[];
      }
    ).listeners;
    expect(subscribed.map((l) => l.event).sort()).toEqual([
      "delete",
      "modify",
      "rename",
    ]);
  });

  it("start() is idempotent — calling twice does NOT duplicate listeners", async () => {
    await f.store.load();
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
    });
    watcher.start();
    watcher.start();
    const count = (f.vault as unknown as { listeners: unknown[] }).listeners
      .length;
    expect(count).toBe(3); // 3 events, not 6
  });

  it("stop() unsubscribes all listeners", async () => {
    await f.store.load();
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
    });
    watcher.start();
    watcher.stop();
    expect(
      (f.vault as unknown as { listeners: unknown[] }).listeners.length,
    ).toBe(0);
  });

  // ─── End-to-end via mock fireEvent ──────────────────────────────────

  it("end-to-end: vault.fireEvent('delete', sibling) → record resolved", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
    });
    watcher.start();

    fs.unlinkSync(path.join(f.root, rec.siblingPath));
    f.vault.fireEvent("delete", { path: rec.siblingPath });
    await watcher.flush();

    expect(f.store.get(rec.id)).toBeUndefined();
  });

  it("end-to-end: vault.fireEvent('rename', new, old) → both paths checked", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    let evalCount = 0;
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      onResolution: () => {
        evalCount++;
      },
    });
    watcher.start();

    // Rename event: new path is unrelated, old path was the base.
    // Old-path check should match (hasPending).
    f.vault.fireEvent(
      "rename",
      { path: "unrelated/new.md" },
      "Notes/note.md",
    );
    await watcher.flush();
    expect(evalCount).toBe(1);
  });

  // ─── Error handling ────────────────────────────────────────────────

  it("onError catches eval failures; chain stays alive for subsequent events", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    let evalCount = 0;
    let errorCount = 0;
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      onResolution: () => {
        evalCount++;
        if (evalCount === 1) throw new Error("boom");
      },
      onError: () => {
        errorCount++;
      },
    });

    // First call throws inside onResolution.
    fs.unlinkSync(path.join(f.root, rec.siblingPath));
    await watcher.handle(rec.siblingPath);
    await watcher.flush();
    expect(errorCount).toBe(1);

    // Second call still goes through (different store state but
    // verifies the chain didn't dead-end).
    const rec2 = await f.store.create(baseArgs({ theirsBlobSha: "t2" }));
    fs.unlinkSync(path.join(f.root, rec2.siblingPath));
    await watcher.handle(rec2.siblingPath);
    await watcher.flush();
    expect(evalCount).toBe(2);
  });
});
