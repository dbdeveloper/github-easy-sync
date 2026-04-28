import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  listVaultFiles,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeRemoteFile,
  writeVaultFile,
} from "../../helpers";

// E3b — atomic plugin .js conflict when both sides have the SAME
// manifest.version. compareSemver returns 0, so the resolver falls
// through to the timestamp tiebreaker (later side wins). We push
// from web-UI AFTER the local edit, so remote.lastModified > local
// → remote wins.
//
// Two sub-tests sharing setup:
//   1. keepPluginConflictCopy = false (default) → no .conflict-*
//      backup is created for the loser .js (plugin folders stay
//      tidy on every divergence).
//   2. keepPluginConflictCopy = true → backup file appears next to
//      the winner, exactly like the binary conflict path (E2).
describe.skipIf(!integrationEnabled())(
  "E3b — same-version plugin .js conflict, timestamp tiebreaker",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("e3b");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    const otherPluginId = "fake-plugin";
    const pluginRoot = `.obsidian/plugins/${otherPluginId}`;
    const mainJsPath = `${pluginRoot}/main.js`;
    const manifestJsonPath = `${pluginRoot}/manifest.json`;
    const sameVersionManifest = JSON.stringify(
      { id: otherPluginId, name: "Fake", version: "1.0.0" },
      null,
      2,
    );
    const localMainJs = "// local edit\nmodule.exports = { local: true };\n";
    const remoteMainJs = "// remote edit (newer)\nmodule.exports = { remote: true };\n";

    async function setupAndDiverge(
      keepPluginConflictCopy: boolean,
    ): Promise<TestClient> {
      const c = createClient({
        branch,
        deviceName: "e3b-test",
        syncConfigDir: true,
        onConflicts: async () => {
          throw new Error("E3b unexpectedly triggered the text-conflict modal");
        },
        onAmbiguous: async () => {
          throw new Error("E3b unexpectedly triggered the init-state modal");
        },
      });
      // Override the setting via direct mutation — createClient
      // doesn't expose this knob through ClientOptions.
      c.settings.keepPluginConflictCopy = keepPluginConflictCopy;

      // Prime: ship v1.0.0 from local.
      await writeVaultFile(c.vault, mainJsPath, localMainJs);
      await writeVaultFile(c.vault, manifestJsonPath, sameVersionManifest);
      await c.sync.loadMetadata();
      await syncAndAssertNoErrors(c);

      // Local edit (older).
      await writeVaultFile(
        c.vault,
        mainJsPath,
        "// initial local push (older lastModified)\n",
      );

      // Web-UI overwrite (newer lastModified) — manifest.version
      // unchanged, so version comparison returns 0 → timestamp
      // tiebreaker → remote wins.
      await writeRemoteFile(
        branch,
        mainJsPath,
        remoteMainJs,
        "E3b: web-UI overwrite of plugin main.js",
      );

      // Resolve.
      await c.sync.loadMetadata();
      await syncAndAssertNoErrors(c);
      return c;
    }

    it(
      "default: no backup when keepPluginConflictCopy is off",
      async () => {
        client = await setupAndDiverge(false);
        const localFiles = await listVaultFiles(client.vault, {
          includeConfigDir: true,
        });
        const backups = localFiles.filter(
          (p) =>
            p.startsWith(`${pluginRoot}/main.conflict-`) && p.endsWith(".js"),
        );
        expect(
          backups,
          `keepPluginConflictCopy=false: should NOT create a backup, but got: ${JSON.stringify(backups)}`,
        ).toEqual([]);
      },
      120_000,
    );

    it(
      "opt-in: backup appears locally but NOT on remote (gitignore blocks it)",
      async () => {
        client = await setupAndDiverge(true);

        // Local: exactly one .conflict-* sidecar next to main.js.
        const localFiles = await listVaultFiles(client.vault, {
          includeConfigDir: true,
        });
        const localBackups = localFiles.filter(
          (p) =>
            p.startsWith(`${pluginRoot}/main.conflict-`) && p.endsWith(".js"),
        );
        expect(
          localBackups.length,
          `keepPluginConflictCopy=true: expected one local backup, got: ${JSON.stringify(localBackups)}`,
        ).toBe(1);

        // Remote: the per-plugin folder allowlist in <configDir>/
        // .gitignore is `plugins/*/*` with negations only for
        // data.json / main.js / manifest.json / styles.css. Anything
        // else inside another plugin's folder — including our
        // conflict backup — is gitignored, so isSyncable rejects it
        // and the upload pipeline never includes it.
        const remoteFiles = await listRemoteFiles(branch);
        const remoteBackups = remoteFiles.filter(
          (p) =>
            p.startsWith(`${pluginRoot}/main.conflict-`) && p.endsWith(".js"),
        );
        expect(
          remoteBackups,
          `conflict backup leaked to remote despite plugin-folder gitignore: ${JSON.stringify(remoteBackups)}`,
        ).toEqual([]);
      },
      120_000,
    );
  },
);
