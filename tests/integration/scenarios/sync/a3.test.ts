import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listVaultFiles,
  readVaultFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// A3 covers the multi-device "load my notes from GitHub into a fresh
// vault" flow. Two clients on the same branch:
//   - client1: vault with user notes, syncs first → adoption pushes
//     the notes plus manifest to the test branch.
//   - client2: empty tempdir vault, syncs after → analyzeLocalState
//     returns "empty" (per the infraPaths rule), decideInitAction
//     routes to first-sync-from-remote, downloadAllFilesViaAPI pulls
//     everything into client2's vault.
// The assertion is convergence: client2's vault contents must match
// what client1 published.
describe.skipIf(!integrationEnabled())(
  "A3 — first-sync-from-remote into an empty vault",
  () => {
    let client1: TestClient | undefined;
    let client2: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      // Make sure the int-test repo has at least one commit on its
      // default branch. The first ever run does the bootstrap; later
      // runs are a single GET /branches probe that returns instantly.
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("a3");
      // Branch off the default branch so the test branch starts with
      // the baseline manifest + .gitignore — non-bare, no need to go
      // through the bootstrap path.
      const head = await getDefaultBranchHead();
      if (!head) {
        throw new Error("default branch missing after ensureRepoNotBare");
      }
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client1?.cleanup();
      client2?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "client2 ends up with the notes client1 just pushed",
      async () => {
        // ---- client1: seed vault, sync to branch ----------------
        client1 = createClient({ branch, deviceName: "a3-client1" });
        await writeVaultFile(
          client1.vault,
          "Notes/note-from-client1.md",
          "# Hello from client1\n\nA3 — round-trip via GitHub.\n",
        );
        await writeVaultFile(
          client1.vault,
          "Notes/inbox/quick-thought.md",
          "Nested directory check.\n",
        );

        await client1.sync.loadMetadata();
        await syncAndAssertNoErrors(client1);

        // ---- client2: empty vault, sync to same branch ---------
        client2 = createClient({ branch, deviceName: "a3-client2" });
        // Don't write anything — vault stays "empty" per infraPaths
        // (only Welcome.md is missing, plugin's own folder + auto-
        // created .gitignore files are infra). loadMetadata + sync
        // should route to first-sync-from-remote.
        await client2.sync.loadMetadata();
        await syncAndAssertNoErrors(client2);

        // ---- assert convergence --------------------------------
        const note1 = await readVaultFile(
          client2.vault,
          "Notes/note-from-client1.md",
        );
        expect(note1).toBe(
          "# Hello from client1\n\nA3 — round-trip via GitHub.\n",
        );
        const note2 = await readVaultFile(
          client2.vault,
          "Notes/inbox/quick-thought.md",
        );
        expect(note2).toBe("Nested directory check.\n");

        // Both notes must show up in the vault listing too — guards
        // against a partial download where the file got created but
        // metadata didn't track it.
        const userFiles = await listVaultFiles(client2.vault);
        expect(userFiles).toContain("Notes/note-from-client1.md");
        expect(userFiles).toContain("Notes/inbox/quick-thought.md");
      },
      120_000,
    );
  },
);
