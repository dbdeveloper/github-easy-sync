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

// E4 — user adds a gitignore rule, then creates a file matching it.
// The file must NOT end up on remote, the .gitignore change itself
// must, and a sibling file in the same folder that doesn't match the
// rule still syncs normally. Confirms isSyncable's deference to the
// gitignore matcher (rule 4) on the upload path.
describe.skipIf(!integrationEnabled())(
  "E4 — gitignore blocks a file from sync",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("e4");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "files matching a user-added gitignore rule never reach remote",
      async () => {
        client = createClient({
          branch,
          deviceName: "e4-test",
          syncConfigDir: true,
        });
        await client.sync.loadMetadata();
        // Prime sync first so the vault and remote are in sync.
        await syncAndAssertNoErrors(client);

        // Edit the root .gitignore (already created by GitignoreCache.
        // initialize() with the default seed) — append a folder
        // ignore. We append rather than overwrite so the seed's
        // existing rules (.DS_Store, etc.) stay.
        const rootGitignorePath = ".gitignore";
        const existingGitignore = await client.vault.adapter.read(
          rootGitignorePath,
        );
        await client.vault.adapter.write(
          rootGitignorePath,
          existingGitignore + "\n# E4: ignore Notes/private/\nNotes/private/\n",
        );

        // Create a "secret" file the gitignore should block AND a
        // sibling file that should still sync normally.
        await writeVaultFile(
          client.vault,
          "Notes/private/secret.md",
          "Should never reach remote.\n",
        );
        await writeVaultFile(
          client.vault,
          "Notes/public/visible.md",
          "Should sync normally.\n",
        );

        // Re-load metadata so reconcile picks up the new files (the
        // events listener mock is a no-op), then sync.
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const remote = await listRemoteFiles(branch);
        expect(remote).toContain("Notes/public/visible.md");
        expect(remote).toContain(".gitignore"); // updated rule must propagate
        expect(
          remote,
          `secret file leaked to remote despite gitignore rule. Tree: ${JSON.stringify(remote)}`,
        ).not.toContain("Notes/private/secret.md");
      },
      120_000,
    );
  },
);
