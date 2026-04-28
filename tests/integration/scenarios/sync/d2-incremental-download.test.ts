import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readVaultFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  vaultFileExists,
  writeRemoteFile,
} from "../../helpers";

// D2: a file appears on remote between two of the client's syncs
// (same flow as someone editing via the GitHub web UI). The plugin's
// next sync should detect the new tree entry, classify it as
// remote-only, download it, and persist locally.
describe.skipIf(!integrationEnabled())(
  "D2 — incremental download of a file added remotely",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("d2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "downloads a file added on remote between syncs",
      async () => {
        client = createClient({ branch, deviceName: "d2-test" });

        // Prime: empty vault → first-sync-from-remote populates
        // baseline locally, lastSync stamped.
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Simulate web-UI edit: write a file directly to the branch
        // through GitHub's Contents API, bypassing the SyncManager.
        const newPath = "Notes/d2-from-web.md";
        const newContent =
          "# Created via web UI\n\nThe plugin must pick this up next sync.\n";
        await writeRemoteFile(branch, newPath, newContent, "D2: web-UI edit");

        // Local doesn't have the file yet.
        expect(await vaultFileExists(client.vault, newPath)).toBe(false);

        // Second sync should detect + download it. The reconciliation
        // in syncImpl bridges tree → manifest, then determineSyncActions
        // emits a download action because the path is in remote
        // metadata but not in local metadata.
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        expect(await vaultFileExists(client.vault, newPath)).toBe(true);
        const localContent = await readVaultFile(client.vault, newPath);
        expect(localContent).toBe(newContent);
      },
      120_000,
    );
  },
);
