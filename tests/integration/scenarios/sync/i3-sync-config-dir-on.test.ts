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

// I3 — toggle `syncConfigDir` from OFF to ON when there's already
// a sizable batch of files under <configDir> on disk.
//
// What the toggle does (settings/tab.ts:179-180): mutates setting,
// then calls addConfigDirToMetadata() which walks <configDir>,
// adds each syncable file as a fresh entry (sha=null, dirty=false)
// and drops stale entries that don't pass isSyncable anymore
// (sync-manager.ts:2208-2216, 2222-2230). The next sync sees a
// pile of "manifest tracks it, no remote tree entry" → upload
// actions for every one of them.
//
// We seed a deliberately non-trivial number of files (12) so the
// sync exercises the per-file upload loop end to end. Without this,
// a 1-file test would pass even if there were a subtle off-by-one
// in the bulk path.
//
// Sequence:
//   1. Client primes with syncConfigDir=false. Remote ends up with
//      just user notes + the manifest path; the rest of configDir
//      stays out of the tree.
//   2. Stage 12 files under configDir on disk: a few in
//      <configDir>/snippets/, a few in
//      <configDir>/themes/, and a few directly under <configDir>/.
//      None of these would be touched by the OFF setting.
//   3. Toggle ON: settings.syncConfigDir=true +
//      addConfigDirToMetadata().
//   4. Sync.
//
// Asserts: every staged file lands on remote with byte-identical
// content; the count delta on the remote tree includes all 12.
describe.skipIf(!integrationEnabled())(
  "I3 — toggle syncConfigDir ON uploads a backlog of configDir files",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("i3");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "configDir backlog uploads in one sync after toggling the setting on",
      async () => {
        client = createClient({
          branch,
          deviceName: "i3-test",
          syncConfigDir: false,
        });

        // ---- prime with the toggle OFF -------------------------
        // configDir paths are filtered by isSyncable, so even though
        // we'd write some by hand later, they wouldn't hit the
        // remote until the toggle flips.
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, "Notes/i3-prime.md", "prime.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // ---- stage configDir backlog on disk -------------------
        const cfg = client.vault.configDir;
        const staged: { [path: string]: string } = {};
        for (let i = 0; i < 4; i++) {
          staged[`${cfg}/snippets/snippet-${i}.css`] =
            `/* snippet ${i} */\n.foo-${i} { color: red; }\n`;
        }
        for (let i = 0; i < 4; i++) {
          staged[`${cfg}/themes/theme-${i}/manifest.json`] =
            JSON.stringify({ name: `theme-${i}` }) + "\n";
        }
        for (let i = 0; i < 4; i++) {
          staged[`${cfg}/extra-${i}.json`] = JSON.stringify({ idx: i }) + "\n";
        }
        for (const [p, c] of Object.entries(staged)) {
          await writeVaultFile(client.vault, p, c);
        }

        // Sanity: remote does NOT have any of these yet (gate is OFF).
        const remoteWhileOff = await listRemoteFiles(branch);
        for (const p of Object.keys(staged)) {
          expect(remoteWhileOff).not.toContain(p);
        }

        // ---- toggle ON -----------------------------------------
        client.settings.syncConfigDir = true;
        await client.sync.addConfigDirToMetadata();

        // ---- sync uploads the backlog --------------------------
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const remoteAfter = await listRemoteFiles(branch);
        for (const [p, c] of Object.entries(staged)) {
          expect(
            remoteAfter,
            `expected ${p} on remote after the toggle`,
          ).toContain(p);
          expect(await readRemoteFile(branch, p)).toBe(c);
        }
      },
      300_000,
    );
  },
);
