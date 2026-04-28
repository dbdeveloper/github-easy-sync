import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// E1 — reconcile-on-onload (disable → edit-vault → re-enable)
//
// In real usage: user disables the plugin, then edits the vault
// through Finder/Files (or another tool) — files appear or get
// deleted while the events listener isn't subscribed. On the next
// plugin load, reconcileWithVault catches the drift by walking the
// disk and updating the manifest accordingly. The next sync then
// propagates those changes to the remote.
//
// We simulate the disable→re-enable cycle by destroying the first
// SyncManager and standing up a fresh one against the same vault
// directory. Between the two, we mutate the vault directly via the
// fs-backed mock adapter — no SyncManager is alive to observe the
// edits, so the ONLY way the second SyncManager learns about them
// is loadMetadata's reconcile pass.
describe.skipIf(!integrationEnabled())(
  "E1 — reconcile picks up off-line edits across plugin restarts",
  () => {
    let session1: TestClient | undefined;
    let session2: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("e1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      // session1's cleanup is a no-op (we passed vaultPath in for
      // session2, so session1 owned the dir originally — but we
      // explicitly remove it here once both are done).
      session1?.cleanup();
      session2?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "files added/removed while plugin was 'down' propagate on next sync",
      async () => {
        // ---- session 1: prime the vault + remote ---------------
        session1 = createClient({ branch, deviceName: "e1-session1" });
        const stableNote = "Notes/stable.md";
        const willBeDeleted = "Notes/about-to-go.md";
        await writeVaultFile(session1.vault, stableNote, "Stays through E1.\n");
        await writeVaultFile(
          session1.vault,
          willBeDeleted,
          "Will be removed externally before session 2.\n",
        );
        await session1.sync.loadMetadata();
        await syncAndAssertNoErrors(session1);

        const remoteAfterPrime = await listRemoteFiles(branch);
        expect(remoteAfterPrime).toContain(stableNote);
        expect(remoteAfterPrime).toContain(willBeDeleted);

        // ---- "plugin disabled" — mutate the vault from outside --
        //
        // Use the same fs-backed adapter the SyncManager would have
        // used, but with NO SyncManager around to observe. We hold
        // on to the vaultPath so we can spin up a second SyncManager
        // against the very same directory.
        const vaultPath = session1.vaultPath;
        const externalAdd = "Notes/external-add.md";
        const externalContent =
          "# Added while plugin was disabled\n\nReconcile must catch this.\n";
        await session1.vault.adapter.write(externalAdd, externalContent);
        await session1.vault.adapter.remove(willBeDeleted);

        // ---- "plugin re-enabled" — fresh SyncManager, same vault
        session2 = createClient({
          branch,
          deviceName: "e1-session2",
          vaultPath,
        });
        // loadMetadata is what runs reconcileWithVault. After this
        // call the new in-memory metadata should already have:
        //   - externalAdd entered as a fresh sha=null entry
        //   - willBeDeleted flagged deleted=true with deletedAt=now
        await session2.sync.loadMetadata();

        // Sync should propagate both deltas.
        await syncAndAssertNoErrors(session2);

        const remoteAfterSession2 = await listRemoteFiles(branch);
        expect(
          remoteAfterSession2,
          "external add should have landed on remote",
        ).toContain(externalAdd);
        expect(
          remoteAfterSession2,
          "external delete should have removed the file from remote",
        ).not.toContain(willBeDeleted);
        expect(remoteAfterSession2).toContain(stableNote);
      },
      120_000,
    );
  },
);
