import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  readRemoteFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeRemoteFile,
  writeVaultFile,
} from "../../helpers";

// K3 — remote manifest's lastSync is in the future (clock-skewed
// device synced earlier, or someone hand-edited the manifest blob).
//
// Where lastSync feeds reconciliation:
//   * sync-manager.ts:1117 — when a remote-tree-deletion is
//     detected via inverse-reconcile, the manifest's lastSync is
//     used as the deletedAt timestamp. A far-future lastSync makes
//     every remote-deletion-vs-local-edit comparison favor the
//     deletion (because no local mtime can outrank the future).
//   * Conflict-detection in findDivergedPaths uses SHAs, not
//     timestamps, so a future lastSync doesn't manufacture spurious
//     conflicts on its own.
//
// The user-facing contract we lock in here: a future lastSync does
// NOT crash the sync, and routine operations (local edit → upload)
// still work. The "deletion timestamp tilts toward delete" subtle
// semantics are documented but not exercised — that would warrant
// its own G-style test if anyone wants to nail it down.
//
// Sequence:
//   1. Prime branch normally. Capture manifest.
//   2. Web-UI overwrite the manifest with the same content but
//      lastSync set to ~1 year in the future.
//   3. Add a new local file. Sync.
//   4. Assert: no error notice, new file lands on remote, the
//      future timestamp didn't break anything user-visible.
describe.skipIf(!integrationEnabled())(
  "K3 — manifest with future lastSync still allows incremental sync",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("k3");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "future lastSync passes through; new file uploads normally",
      async () => {
        const manifestPath = ".obsidian/github-easy-sync-metadata.json";
        const seedNote = "Notes/k3-prime.md";
        const seedContent = "prime.\n";

        client = createClient({ branch, deviceName: "k3-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, seedNote, seedContent);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Read the well-formed manifest, bump lastSync ~1 year
        // forward, write it back.
        const goodText = await readRemoteFile(branch, manifestPath);
        const m = JSON.parse(goodText) as { lastSync: number };
        const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
        const skewed = JSON.stringify({ ...m, lastSync: future });
        await writeRemoteFile(
          branch,
          manifestPath,
          skewed,
          "K3: future lastSync",
        );

        // ---- new local edit + sync -----------------------------
        const newNote = "Notes/k3-after-skew.md";
        const newContent = "should land despite the future lastSync.\n";
        await writeVaultFile(client.vault, newNote, newContent);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const remote = await listRemoteFiles(branch);
        expect(remote).toContain(newNote);
        expect(await readRemoteFile(branch, newNote)).toBe(newContent);
        // Original seed survives.
        expect(remote).toContain(seedNote);
        expect(await readRemoteFile(branch, seedNote)).toBe(seedContent);
      },
      240_000,
    );
  },
);
