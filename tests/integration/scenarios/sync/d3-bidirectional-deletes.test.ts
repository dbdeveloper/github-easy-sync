import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  removeRemoteFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  vaultFileExists,
  writeVaultFile,
} from "../../helpers";

// D3: each side independently deletes a different file between two
// syncs. After sync, both deletions should propagate symmetrically:
// the locally-deleted file disappears from remote, the remotely-
// deleted file disappears from local. Exercises the inverse
// reconciliation path in syncImpl (manifest entry without a tree
// entry → mark deleted with deletedAt = remoteMetadata.lastSync) and
// the deletion-handling reorder in determineSyncActions (deletion
// checks BEFORE the SHA-equality short-circuit).
describe.skipIf(!integrationEnabled())(
  "D3 — bidirectional deletes propagate to both sides",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("d3");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "local-side delete uploads as removal; remote-side delete pulls as removal",
      async () => {
        client = createClient({ branch, deviceName: "d3-test" });

        // Prime with two files that we'll later delete from
        // opposite sides.
        const localOnePath = "Notes/keep-on-remote-delete-locally.md";
        const remoteOnePath = "Notes/keep-on-local-delete-remotely.md";
        await writeVaultFile(client.vault, localOnePath, "delete me locally\n");
        await writeVaultFile(client.vault, remoteOnePath, "delete me remotely\n");

        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Sanity: both files on remote.
        let remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).toContain(localOnePath);
        expect(remoteFiles).toContain(remoteOnePath);

        // Side 1 — delete locally.
        await client.vault.adapter.remove(localOnePath);

        // Side 2 — delete remotely (simulates web-UI delete).
        await removeRemoteFile(branch, remoteOnePath, "D3: web-UI delete");

        // Confirm the web-UI delete actually committed to the tree
        // BEFORE asking the plugin to sync. If GitHub's eventual
        // consistency hasn't caught up, the plugin would see both
        // files in the tree and the inverse-reconcile path
        // (manifest entry but no tree entry → mark deleted) wouldn't
        // fire for remoteOnePath.
        const remoteAfterWebDelete = await listRemoteFiles(branch);
        expect(
          remoteAfterWebDelete,
          `web-UI delete must have removed ${remoteOnePath} before second sync. Tree: ${JSON.stringify(remoteAfterWebDelete)}`,
        ).not.toContain(remoteOnePath);

        // Sync. Re-run loadMetadata first so the on-disk-but-
        // missing file is reconciled into "deleted" in the local
        // manifest (events listener mock can't see fs.unlink calls).
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // After sync:
        //   - localOnePath: gone from remote (delete_remote action)
        //   - remoteOnePath: gone from local (delete_local action,
        //     emitted because remote tree no longer has it)
        remoteFiles = await listRemoteFiles(branch);
        expect(
          remoteFiles,
          "local-deleted file should be gone from remote",
        ).not.toContain(localOnePath);
        expect(
          remoteFiles,
          "remote-deleted file should also be gone from remote (still)",
        ).not.toContain(remoteOnePath);

        expect(
          await vaultFileExists(client.vault, localOnePath),
          "locally-deleted file should stay gone locally",
        ).toBe(false);
        expect(
          await vaultFileExists(client.vault, remoteOnePath),
          "remote-deleted file should be removed from local vault too",
        ).toBe(false);
      },
      120_000,
    );
  },
);
