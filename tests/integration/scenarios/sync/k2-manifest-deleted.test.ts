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
  removeRemoteFile,
  syncAndCollectErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// K2 — remote manifest deleted via the GitHub web UI. The remote
// tree still has user files, just no manifest entry.
//
// Trace (this test pins the current behavior):
//   * analyzeRemoteState calls getRepoContent → tree returns user
//     files but no manifest item → sync-state.ts:282-287 returns
//     RemoteState.kind="has-content-no-manifest".
//   * analyzeLocalState reports "has-manifest" because the local
//     vault DID complete a prior sync (lastSync > 0).
//   * decideInitAction line 343-349: local has-manifest + remote
//     has-content-no-manifest → returns "needs-adoption-analysis".
//   * compareForAdoption hashes every local file and intersects
//     with the remote tree's SHAs. Since local was last in sync
//     with this branch, identical=N, conflicting=0, localOnly=
//     remoteOnly=0 → shouldAutoAdopt returns true.
//   * Adoption commits a fresh manifest (sync-manager.ts
//     adoptCurrentState path) → manifest is back on remote.
//
// Net contract for the user: deleting the manifest in the web UI
// is recoverable. The next sync from any device that had the
// branch synced silently re-publishes the manifest. No user
// prompt, no data loss.
//
// We then run an incremental sync to confirm the post-recovery
// state behaves like a normal regular-sync (writing a new file).
describe.skipIf(!integrationEnabled())(
  "K2 — manifest deleted from remote: silent re-adoption republishes it",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("k2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "post-deletion sync re-creates the manifest via silent adoption",
      async () => {
        const manifestPath = ".obsidian/github-easy-sync-metadata.json";
        const seedNote = "Notes/k2-prime.md";
        const seedContent = "# k2 prime\nshould survive manifest deletion.\n";

        client = createClient({
          branch,
          deviceName: "k2-test",
          // The adoption analysis here MUST be silent — local matches
          // remote, no conflicts. If the modal fires, we missed
          // something in the routing.
          onAmbiguous: async (info) => {
            throw new Error(
              "K2: ambiguous-state modal fired but local matches remote — " +
                JSON.stringify({
                  identical: info.analysis.identical.length,
                  localOnly: info.analysis.localOnly,
                  remoteOnly: info.analysis.remoteOnly,
                  conflicting: info.analysis.conflicting,
                }),
            );
          },
        });

        // ---- prime: client populates branch + manifest ---------
        await client.sync.loadMetadata();
        await syncAndCollectErrors(client); // first-sync-from-remote
        await writeVaultFile(client.vault, seedNote, seedContent);
        await client.sync.loadMetadata();
        await syncAndCollectErrors(client); // upload seedNote
        expect(await listRemoteFiles(branch)).toContain(manifestPath);

        // ---- web-UI delete the manifest ------------------------
        await removeRemoteFile(
          branch,
          manifestPath,
          "K2: web-UI delete manifest",
        );
        const treeAfterDelete = await listRemoteFiles(branch);
        expect(treeAfterDelete).not.toContain(manifestPath);
        expect(treeAfterDelete).toContain(seedNote);

        // ---- sync triggers adoption analysis + silent re-adopt --
        await client.sync.loadMetadata();
        const adoptErrors = await syncAndCollectErrors(client);
        expect(
          adoptErrors,
          `adoption sync should have no errors; got: ${adoptErrors.join(" | ")}`,
        ).toEqual([]);

        // Manifest is back on remote.
        const treeAfterAdopt = await listRemoteFiles(branch);
        expect(treeAfterAdopt).toContain(manifestPath);
        // User file untouched.
        expect(treeAfterAdopt).toContain(seedNote);
        expect(await readRemoteFile(branch, seedNote)).toBe(seedContent);

        // ---- regular incremental still works -------------------
        const followup = "Notes/k2-followup.md";
        const followupContent = "post-recovery incremental sync.\n";
        await writeVaultFile(client.vault, followup, followupContent);
        await client.sync.loadMetadata();
        const incrementalErrors = await syncAndCollectErrors(client);
        expect(
          incrementalErrors,
          `post-adopt incremental sync should be clean; got: ${incrementalErrors.join(" | ")}`,
        ).toEqual([]);

        const finalTree = await listRemoteFiles(branch);
        expect(finalTree).toContain(followup);
        expect(await readRemoteFile(branch, followup)).toBe(followupContent);
      },
      300_000,
    );
  },
);
