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
  writeVaultFile,
} from "../../helpers";

// D1: regular incremental sync after a primed initial sync. The
// pattern is "vault and remote are in sync (both has-manifest), user
// adds a file locally, hits Sync". Plugin should route through
// regular-sync → determineSyncActions → upload action for the new
// file → commitSync.
describe.skipIf(!integrationEnabled())(
  "D1 — incremental upload of a newly-added local file",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("d1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "uploads a single new file on the second sync",
      async () => {
        client = createClient({ branch, deviceName: "d1-test" });

        // Prime: empty vault → first-sync-from-remote pulls baseline,
        // commitSync stamps lastSync. Now both sides are has-manifest.
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const beforeFiles = await listRemoteFiles(branch);
        expect(beforeFiles).not.toContain("Notes/d1-new.md");

        // Simulate user creating a file in Obsidian. The events
        // listener mock is a no-op (vault.on isn't fired), so we
        // re-run loadMetadata between syncs — that calls
        // reconcileWithVault which adds the on-disk-but-untracked
        // file to metadata (sha=null), exactly as the real events
        // listener would on file create.
        const newPath = "Notes/d1-new.md";
        const newContent = "# New file\n\nAdded after the first sync.\n";
        await writeVaultFile(client.vault, newPath, newContent);
        await client.sync.loadMetadata();

        await syncAndAssertNoErrors(client);

        const afterFiles = await listRemoteFiles(branch);
        expect(afterFiles).toContain(newPath);
        const remoteContent = await readRemoteFile(branch, newPath);
        expect(remoteContent).toBe(newContent);
      },
      120_000,
    );
  },
);
