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

// G4 — A deletes foo.md, B modifies it later → on B's next sync the
// modification "resurrects" the file on remote.
//
// This exercises the `remoteFile.deleted && !localFile.deleted`
// branch in determineSyncActions (line 1698) — the case where the
// other side dropped the file but our local edit is more recent than
// their deletion. The plugin emits an upload, putting the file back
// in the tree.
//
// Why we have to poke `localFile.lastModified` manually:
//   In real Obsidian, the events listener (events-listener.ts:106)
//   sets `lastModified = Date.now()` on every modify event. The
//   integration-test mock doesn't dispatch vault events, so a plain
//   adapter.write changes disk content but leaves the manifest's
//   lastModified at whatever it was at download time — i.e., BEFORE
//   A's deletion. With a stale lastModified, the resurrection
//   condition (line 1705: `localFile.lastModified > remoteFile.
//   deletedAt`) is false and the plugin would emit delete_local
//   instead. So we explicitly simulate the events-listener "modify"
//   callback by poking the timestamp on B's manifest.
//
// Why this isn't routed through findDivergedPaths instead:
//   A's delete updates A's manifest entry to {deleted:true,
//   deletedAt:TdelA, sha:baseline} — sha is left at baseline (see
//   reconcileWithVault and deleteLocalFile, both leave sha alone).
//   So when B fetches the remote manifest, remoteFile.sha equals
//   B's localFile.sha — `remoteFileHasBeenModifiedSinceLastSync` is
//   FALSE → not a conflict, falls through to determineSyncActions.
//
// Sequence:
//   1. A creates foo.md, syncs. B downloads.
//   2. A deletes foo.md, syncs → remote tree drops foo.md; remote
//      manifest holds deleted=true, deletedAt=TdelA.
//   3. ~250 ms gap so any wall-clock granularity won't muddy
//      lastModified vs deletedAt.
//   4. B writes new content to foo.md, then pokes manifest's
//      lastModified=Date.now() to simulate the events-listener
//      modify event firing.
//   5. B syncs. determineSyncActions sees lastModified > deletedAt
//      → upload. foo.md goes back in remote tree with B's content.
//
// Asserts: foo.md reappears on remote with B's modified content;
// A's next sync downloads B's resurrected version.
describe.skipIf(!integrationEnabled())(
  "G4 — A deletes, B modifies later — file resurrects on remote",
  () => {
    let clientA: TestClient | undefined;
    let clientB: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("g4");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      clientA?.cleanup();
      clientB?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "B's later modify resurrects the file A deleted",
      async () => {
        const target = "Notes/contended.md";
        const baseline = "# baseline\nstart shared.\n";
        const resurrectedContent = "# resurrected\nB's edit after A deleted.\n";

        // ---- prime: A creates + syncs, B downloads -------------
        clientA = createClient({ branch, deviceName: "g4-A" });
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        await writeVaultFile(clientA.vault, target, baseline);
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);

        clientB = createClient({ branch, deviceName: "g4-B" });
        await clientB.sync.loadMetadata();
        await syncAndAssertNoErrors(clientB);

        // ---- A deletes + syncs ----------------------------------
        await clientA.vault.adapter.remove(target);
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        expect(await listRemoteFiles(branch)).not.toContain(target);

        // ---- gap so B's poked lastModified strictly > deletedAt
        await new Promise((r) => setTimeout(r, 250));

        // ---- B modifies + simulates events-listener -------------
        // Order matters: write disk first, THEN load metadata (so
        // reconcile sees the file is still present), THEN poke
        // lastModified. If we poked before loadMetadata, save() in
        // load() could rewrite the timestamp before sync uses it —
        // but reconcile leaves existing-file entries alone so this
        // is just defensive ordering.
        await writeVaultFile(clientB.vault, target, resurrectedContent);
        await clientB.sync.loadMetadata();

        // Simulate events-listener.ts:106 firing on the modify event.
        // The mock vault doesn't dispatch vault.on("modify") for
        // adapter.write, so the manifest's lastModified would stay
        // at download-time without this hand-rolled bump.
        const metadataStore = (clientB.sync as unknown as {
          metadataStore: {
            data: { files: Record<string, { lastModified: number }> };
            save: () => Promise<void>;
          };
        }).metadataStore;
        metadataStore.data.files[target].lastModified = Date.now();
        await metadataStore.save();

        await syncAndAssertNoErrors(clientB);

        // ---- assert file is back on remote with B's content -----
        const remote = await listRemoteFiles(branch);
        expect(
          remote,
          `expected ${target} resurrected on remote. Tree: ${JSON.stringify(remote)}`,
        ).toContain(target);
        expect(await readRemoteFile(branch, target)).toBe(resurrectedContent);

        // ---- A re-syncs and downloads the resurrected file ------
        await clientA.sync.loadMetadata();
        await syncAndAssertNoErrors(clientA);
        const finalRemote = await listRemoteFiles(branch);
        expect(finalRemote).toContain(target);
      },
      300_000,
    );
  },
);
