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

// B2: silent adoption when client2 has the same files as the remote
// PLUS one extra local-only file. compareForAdoption produces
// identical=N, localOnly=[localOnly.md], remoteOnly=0, conflicting=0
// → shouldAutoAdopt returns true → silent path. The local-only file
// must end up on remote in the same commit (no separate follow-up
// upload, since the post-adoption syncImpl runs only when
// remoteOnly is non-empty).
describe.skipIf(!integrationEnabled())(
  "B2 — silent adopt with one-sided extras",
  () => {
    let client1: TestClient | undefined;
    let client2: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("b2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client1?.cleanup();
      client2?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "client2's extra local file lands on the remote without prompting",
      async () => {
        const sharedFiles: { [path: string]: string } = {
          "Notes/shared-a.md": "Shared file alpha\n",
          "Notes/shared-b.md": "Shared file beta\n",
        };
        const localExtra = {
          path: "Notes/local-only.md",
          content: "# Only on client2\nThis must end up on remote.\n",
        };

        // ---- client1: seed shared content, push -----------------
        client1 = createClient({ branch, deviceName: "b2-client1" });
        for (const [p, c] of Object.entries(sharedFiles)) {
          await writeVaultFile(client1.vault, p, c);
        }
        await client1.sync.loadMetadata();
        await syncAndAssertNoErrors(client1);

        // ---- client2: seed shared + extra, sync ----------------
        client2 = createClient({
          branch,
          deviceName: "b2-client2",
          onAmbiguous: async () => {
            throw new Error(
              "B2: ambiguous-state modal fired but only one-sided extras were expected (no real conflict).",
            );
          },
        });
        for (const [p, c] of Object.entries(sharedFiles)) {
          await writeVaultFile(client2.vault, p, c);
        }
        await writeVaultFile(client2.vault, localExtra.path, localExtra.content);
        await client2.sync.loadMetadata();
        await syncAndAssertNoErrors(client2);

        // ---- assert remote has every shared file + the extra ----
        const remoteFiles = await listRemoteFiles(branch);
        for (const p of Object.keys(sharedFiles)) {
          expect(remoteFiles, `remote should still contain ${p}`).toContain(p);
        }
        expect(
          remoteFiles,
          `remote should have picked up the local-only extra ${localExtra.path}`,
        ).toContain(localExtra.path);
      },
      120_000,
    );
  },
);
