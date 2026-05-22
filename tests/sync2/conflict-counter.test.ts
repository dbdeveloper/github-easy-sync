// Phase 3 Group 5 RED tests for the Stage 13 ConflictCounter
// (Phase 1.7 stub at src/sync2/conflict-counter.ts).
//
// All tests in this file currently FAIL with "Not implemented" —
// proper RED state. Phase 4 Group 5 fills in the bodies (per
// PSEUDO-MERGE-MODE.md §"ConflictCounter — dirty-flag + subscribers
// contract" and §"Counter formula + vault.on listeners role") and
// turns these GREEN.
//
// Tests exercise the Phase 4 API surface, not the current
// implementation — advisor's pitfall warning.

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
import { ConflictCounter } from "../../src/sync2/conflict-counter";
import { Vault } from "../../mock-obsidian";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

// A controllable microtask scheduler so tests can verify the
// debounce behavior: many markDirty() calls within one "tick"
// should coalesce into a single scheduled recompute. The test
// fixture exposes pending() / flush() so each test drives the
// schedule explicitly.
function makeScheduler() {
  let queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      queue.push(fn);
    },
    pending: () => queue.length,
    flush: () => {
      const drained = queue;
      queue = [];
      for (const fn of drained) fn();
    },
  };
}

function arr(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer.slice(0) as ArrayBuffer;
}

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `conflict-counter-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  let idCounter = 0;
  const store = new ConflictStore({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => Date.now(),
    idFactory: () =>
      `00000000-0000-0000-0000-${String(++idCounter).padStart(12, "0")}`,
  });
  const scheduler = makeScheduler();
  const counter = new ConflictCounter({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    scheduleMicrotask: scheduler.schedule,
  });
  return { root, vault, store, counter, scheduler };
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
    theirsBlobSha: "theirs-sha",
    oursBlobSha: "ours-sha",
    baseMtime: null,
    baseSize: null,
    baseSha: null,
    remoteDevice: "Phone",
    ...over,
  };
}

describe("ConflictCounter (Stage 13)", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  // ─── N1: markDirty coalesces ────────────────────────────────────────

  it("N1: markDirty x10 in the same tick schedules at most one recompute", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    // Create a record so the counter has something to recompute.
    await f.store.create(baseArgs());

    // Reset scheduler — constructor may have done its own initial
    // dirty schedule.
    f.scheduler.flush();

    for (let i = 0; i < 10; i++) f.counter.markDirty();

    expect(f.scheduler.pending()).toBeLessThanOrEqual(1);
  });

  it("N1b: flush makes getValue reflect the live recomputed count", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    const rec = await f.store.create(baseArgs());
    // Force divergence: sibling SHA != base SHA. Record was just
    // created so its cached siblingSha == theirsBlobSha, baseSha is
    // null/unmatched → counts as a conflict.
    void rec;

    f.counter.markDirty();
    await f.counter.flush();
    expect(f.counter.getValue()).toBe(1);

    // Subsequent markDirty without any state change → flush is a
    // cheap no-change recompute, getValue still returns 1.
    f.counter.markDirty();
    await f.counter.flush();
    expect(f.counter.getValue()).toBe(1);
  });

  // ─── N2: subscribe semantics ────────────────────────────────────────

  it("N2: subscribe callback fires only on a value CHANGE, never on a no-op recompute", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.create(baseArgs());

    const calls: number[] = [];
    const unsubscribe = f.counter.subscribe((n) => {
      calls.push(n);
    });

    // First dirty round: count was 0 (initial), now 1 → callback fires.
    f.counter.markDirty();
    await f.counter.flush();

    // Second dirty round: nothing changed, count is still 1 → callback
    // does NOT fire.
    f.counter.markDirty();
    await f.counter.flush();

    expect(calls).toEqual([1]);
    unsubscribe();
  });

  it("N2b: subscribe unsubscribe stops further callbacks", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.create(baseArgs());

    const calls: number[] = [];
    const unsubscribe = f.counter.subscribe((n) => {
      calls.push(n);
    });

    f.counter.markDirty();
    await f.counter.flush();
    expect(calls).toEqual([1]);

    unsubscribe();

    // After unsubscribe: even a real change shouldn't fire the
    // callback.
    await f.store.create(
      baseArgs({ vaultPath: "Other/note.md", theirsBlobSha: "another-sha" }),
    );
    writeVaultFile(f.root, "Other/note.md", "local2\n");
    f.counter.markDirty();
    await f.counter.flush();
    expect(calls).toEqual([1]);
  });

  // ─── N3: flush() forces immediate recompute ─────────────────────────

  it("N3: flush() forces immediate recompute, bypassing microtask debounce", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.create(baseArgs());

    f.counter.markDirty();
    // Without flushing the scheduler manually — flush() should pick
    // up the dirty flag and recompute synchronously (well, via its
    // own awaited path).
    await f.counter.flush();
    expect(f.counter.getValue()).toBe(1);
  });

  // ─── N4: Counter formula edge cases ─────────────────────────────────

  it("N4: empty store → count is 0", async () => {
    await f.store.load();
    f.counter.markDirty();
    await f.counter.flush();
    expect(f.counter.getValue()).toBe(0);
  });

  it("N4: record with !siblingExists → NOT counted (will be resolved on next drain)", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    const rec = await f.store.create(baseArgs());

    // User externally deletes the sibling — record stays in store
    // until next drain, but counter shouldn't include it.
    fs.unlinkSync(path.join(f.root, rec.siblingPath));

    f.counter.markDirty();
    await f.counter.flush();
    expect(f.counter.getValue()).toBe(0);
  });

  it("N4: record with !baseExists, siblingExists → COUNTED (base gone, sibling alone)", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.create(baseArgs());

    // User externally deletes the base file. Sibling still on disk.
    fs.unlinkSync(path.join(f.root, "Notes/note.md"));

    f.counter.markDirty();
    await f.counter.flush();
    expect(f.counter.getValue()).toBe(1);
  });

  it("N4: record with siblingSha == baseSha → NOT counted (Phase A will auto-clean)", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "theirs\n");
    // Create with default args, then push base cache to match sibling.
    // User copied sibling content onto base. The record's cached
    // siblingSha now equals the live base SHA. The counter should
    // treat this as "already resolved at the next drain".
    const rec = await f.store.create(baseArgs());
    const baseStat = fs.statSync(path.join(f.root, "Notes/note.md"));
    await f.store.updateCache(rec.id, {
      baseSha: rec.siblingSha,
      baseMtime: baseStat.mtimeMs,
      baseSize: baseStat.size,
    });

    f.counter.markDirty();
    await f.counter.flush();
    expect(f.counter.getValue()).toBe(0);
  });

  it("N4: multiple records with mixed states are counted independently", async () => {
    await f.store.load();
    writeVaultFile(f.root, "a.md", "local-a\n");
    writeVaultFile(f.root, "b.md", "local-b\n");
    writeVaultFile(f.root, "c.md", "local-c\n");

    // a.md: normal conflict → counts as 1
    await f.store.create(baseArgs({ vaultPath: "a.md", theirsBlobSha: "sha-a" }));

    // b.md: user deleted sibling → does NOT count
    const recB = await f.store.create(
      baseArgs({ vaultPath: "b.md", theirsBlobSha: "sha-b" }),
    );
    fs.unlinkSync(path.join(f.root, recB.siblingPath));

    // c.md: normal conflict → counts as 1
    await f.store.create(baseArgs({ vaultPath: "c.md", theirsBlobSha: "sha-c" }));

    f.counter.markDirty();
    await f.counter.flush();
    expect(f.counter.getValue()).toBe(2);
  });

  // ─── N18: bulk vault events coalesce ────────────────────────────────

  it("N18: 100 markDirty calls in tight loop produce a single scheduled recompute", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.create(baseArgs());

    // Reset scheduler after any constructor-time scheduling.
    f.scheduler.flush();

    for (let i = 0; i < 100; i++) f.counter.markDirty();

    expect(f.scheduler.pending()).toBe(1);
  });

  it("N18b: bulk markDirty before any subscriber → still only one callback fire after subscribe + flush", async () => {
    await f.store.load();
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.create(baseArgs());

    for (let i = 0; i < 50; i++) f.counter.markDirty();

    const calls: number[] = [];
    f.counter.subscribe((n) => {
      calls.push(n);
    });

    await f.counter.flush();
    expect(calls.length).toBeLessThanOrEqual(1);
    if (calls.length === 1) expect(calls[0]).toBe(1);
  });
});

