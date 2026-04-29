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

// I2 — toggle `syncConfigDir` from ON to OFF.
//
// What the toggle does (settings/tab.ts:177-184): mutates the
// setting, then calls removeConfigDirFromMetadata(), which deletes
// every <configDir>/* entry from the manifest (except the manifest
// file itself, sync-manager.ts:2263-2266). Then on subsequent syncs
// isSyncable returns false for any configDir path (utils.ts:165) →
// neither uploads nor deletions fire for those paths.
//
// Important contract: pre-existing remote configDir files are NOT
// removed by this toggle. They become orphans in the remote tree.
// This is intentional — turning the setting off means "I don't want
// my plugin to manage those anymore", not "delete them upstream".
// If the user wants them gone they have to delete via the web UI
// or rotate keys; the plugin shouldn't do destructive cleanup just
// because a config flipped.
//
// Sequence:
//   1. Client primes branch with syncConfigDir=true. The bootstrap
//      seeds a few infra files under .obsidian/* (.gitignore,
//      manifest, plugin folder gitignore). After our user notes
//      sync, those configDir files are also on remote.
//   2. Capture the current remote tree (snapshot of "what's there
//      while syncConfigDir=on").
//   3. Toggle OFF: settings.syncConfigDir=false +
//      removeConfigDirFromMetadata().
//   4. Add a new local user note OUTSIDE configDir + sync. The
//      sync should propagate the user note normally.
//   5. Assert: every configDir/* path that existed before the
//      toggle is still on remote (orphaned, not deleted) AND the
//      new user note made it.
describe.skipIf(!integrationEnabled())(
  "I2 — toggle syncConfigDir OFF: remote configDir files orphan, not delete",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("i2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "post-toggle sync uploads a new note while leaving remote configDir untouched",
      async () => {
        client = createClient({
          branch,
          deviceName: "i2-test",
          syncConfigDir: true,
        });

        // ---- prime: configDir contents land on remote ----------
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, "Notes/i2-pre.md", "before toggle.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const beforeToggle = await listRemoteFiles(branch);
        const configDirOnRemote = beforeToggle.filter((p) =>
          p.startsWith(".obsidian/"),
        );
        expect(
          configDirOnRemote.length,
          "expected at least one configDir path on remote (bootstrap should seed .obsidian/.gitignore et al.)",
        ).toBeGreaterThan(0);

        // ---- toggle OFF ----------------------------------------
        // Mirrors what tab.ts does: mutate setting + call the
        // metadata-side cleanup so isSyncable's gate kicks in on
        // the next sync.
        client.settings.syncConfigDir = false;
        await client.sync.removeConfigDirFromMetadata();

        // ---- post-toggle sync ----------------------------------
        // Add a new note OUTSIDE configDir to prove the regular-
        // sync path still works while the configDir is off-limits.
        const newNote = "Notes/i2-after.md";
        const newContent = "after toggle.\n";
        await writeVaultFile(client.vault, newNote, newContent);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // ---- assert orphans + new note -------------------------
        const afterToggle = await listRemoteFiles(branch);
        for (const p of configDirOnRemote) {
          expect(
            afterToggle,
            `configDir path ${p} should be orphaned on remote (toggle OFF must not delete remote infra). Tree: ${JSON.stringify(afterToggle)}`,
          ).toContain(p);
        }
        expect(
          afterToggle,
          "new user note should still upload normally",
        ).toContain(newNote);
      },
      180_000,
    );
  },
);
