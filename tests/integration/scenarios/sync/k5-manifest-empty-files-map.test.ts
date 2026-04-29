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

// K5 — remote manifest's `files` map is empty but the tree itself
// still holds the user's files (e.g. someone hand-edited the
// manifest blob, or a buggy version pushed an empty map).
//
// Trace through what happens:
//   * analyzeRemoteState parses the manifest fine — files: {} is
//     valid JSON.
//   * decideInitAction routes to regular-sync (both sides have
//     manifest with lastSync > 0).
//   * syncImpl's forward reconcile (sync-manager.ts:1067-1086)
//     populates remoteMetadata.files from the actual tree, since
//     the manifest's empty map has no entries to compare against.
//     Each path lands as a fresh entry with sha=tree's sha.
//   * Inverse reconcile (line 1107-1119) finds nothing to mark
//     deleted — the loop iterates over the now-populated map,
//     which only contains tree-derived entries.
//   * findDivergedPaths: for files where local SHA matches tree
//     SHA, all three "modified-since-last-sync" booleans need to
//     be true to trip the conflict path. Local hasn't changed +
//     remote hasn't actually changed (just the manifest's view
//     of it) → not flagged.
//   * determineSyncActions: SHAs match between local and remote
//     for every file → no actions.
//
// User contract: the empty `files` map is a recoverable cosmetic
// corruption; the next sync that has any real work to do (a local
// edit) will rewrite the manifest with the full files map again.
//
// Sequence:
//   1. Prime: client writes a note, syncs (manifest now has real
//      `files` entries on remote).
//   2. Web-UI overwrite the manifest preserving lastSync but
//      replacing `files` with `{}`.
//   3. Add a new local file + sync.
//   4. Assert: new file landed; remote manifest's `files` map is
//      now populated again (the local manifest pushed by commitSync
//      has all the real entries).
describe.skipIf(!integrationEnabled())(
  "K5 — manifest with empty files map self-heals on next sync",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("k5");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "files: {} is reconciled from the tree; subsequent sync repopulates the map",
      async () => {
        const manifestPath = ".obsidian/github-sync-metadata.json";
        const seedNote = "Notes/k5-prime.md";
        const seedContent = "prime.\n";

        client = createClient({ branch, deviceName: "k5-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, seedNote, seedContent);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Sanity: the well-formed manifest tracks the seed.
        const original = JSON.parse(
          await readRemoteFile(branch, manifestPath),
        ) as { lastSync: number; files: Record<string, unknown> };
        expect(
          Object.keys(original.files).length,
          "manifest should track multiple paths after the prime sync",
        ).toBeGreaterThan(0);

        // ---- corrupt: drop files map ---------------------------
        const stripped = JSON.stringify({
          lastSync: original.lastSync,
          files: {},
          firstSyncFromRemoteInProgress: false,
          firstSyncFromLocalInProgress: false,
        });
        await writeRemoteFile(
          branch,
          manifestPath,
          stripped,
          "K5: blank files map",
        );

        // ---- new local edit + sync -----------------------------
        const newNote = "Notes/k5-after-blank.md";
        const newContent = "lands; manifest map repopulates.\n";
        await writeVaultFile(client.vault, newNote, newContent);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const remote = await listRemoteFiles(branch);
        expect(remote).toContain(newNote);
        expect(await readRemoteFile(branch, newNote)).toBe(newContent);
        expect(remote).toContain(seedNote);

        // ---- manifest self-healed -------------------------------
        // commitSync writes the local manifest, which has real
        // entries for every tracked file. So the map should hold
        // both seedNote and newNote post-sync.
        const recovered = JSON.parse(
          await readRemoteFile(branch, manifestPath),
        ) as { files: Record<string, unknown> };
        expect(
          recovered.files[seedNote],
          "post-recovery manifest should include the original seed",
        ).toBeDefined();
        expect(
          recovered.files[newNote],
          "post-recovery manifest should include the newly-uploaded file",
        ).toBeDefined();
      },
      300_000,
    );
  },
);
