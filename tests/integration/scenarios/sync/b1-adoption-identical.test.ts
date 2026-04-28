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

// B1: silent adoption when both sides hold identical content. The
// canonical "transitioning from another sync tool" or "second device
// installs and finds the vault already populated" scenario. Plugin
// must NOT show the InitDecisionModal (we wire onAmbiguous to throw,
// so the test fails loudly if it does fire).
describe.skipIf(!integrationEnabled())(
  "B1 — silent adopt with 100% identical content",
  () => {
    let client1: TestClient | undefined;
    let client2: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("b1");
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
      "client2 silently adopts when its files match the remote",
      async () => {
        // ---- client1: seed identical content, push --------------
        const sharedFiles: { [path: string]: string } = {
          "Notes/identical-1.md": "# Same on both sides\nLine A\nLine B\n",
          "Notes/identical-2.md": "Another shared file.\nNothing fancy.\n",
        };
        client1 = createClient({ branch, deviceName: "b1-client1" });
        for (const [p, c] of Object.entries(sharedFiles)) {
          await writeVaultFile(client1.vault, p, c);
        }
        await client1.sync.loadMetadata();
        await syncAndAssertNoErrors(client1);

        // Sanity: remote got the user files.
        const remoteAfter1 = await listRemoteFiles(branch);
        for (const p of Object.keys(sharedFiles)) {
          expect(remoteAfter1, `remote should contain ${p}`).toContain(p);
        }

        // ---- client2: seed SAME content locally, then sync ------
        // No manifest, no prior history — exactly like another
        // device discovering the vault. The plugin's auto-created
        // .gitignore files match what client1 also generated, so
        // adoption sees identical=N, conflicting=0 → silent path.
        client2 = createClient({
          branch,
          deviceName: "b1-client2",
          // Critical: if onAmbiguous fires, this test failed —
          // adoption should NOT prompt the user when content matches.
          onAmbiguous: async (info) => {
            throw new Error(
              "B1 unexpectedly fired the ambiguous-state modal: " +
                JSON.stringify({
                  identical: info.analysis.identical.length,
                  localOnly: info.analysis.localOnly,
                  remoteOnly: info.analysis.remoteOnly,
                  conflicting: info.analysis.conflicting,
                }),
            );
          },
        });
        for (const [p, c] of Object.entries(sharedFiles)) {
          await writeVaultFile(client2.vault, p, c);
        }
        await client2.sync.loadMetadata();
        await syncAndAssertNoErrors(client2);

        // After client2's silent adopt, the remote should still have
        // the same user files (no destructive behaviour) and the
        // manifest must list them.
        const remoteAfter2 = await listRemoteFiles(branch);
        for (const p of Object.keys(sharedFiles)) {
          expect(remoteAfter2, `remote should still contain ${p}`).toContain(p);
        }

        const manifestText = await readRemoteFile(
          branch,
          ".obsidian/github-sync-metadata.json",
        );
        const manifest = JSON.parse(manifestText);
        for (const p of Object.keys(sharedFiles)) {
          expect(
            manifest.files[p],
            `manifest should track ${p} after adoption`,
          ).toBeDefined();
        }
      },
      120_000,
    );
  },
);
