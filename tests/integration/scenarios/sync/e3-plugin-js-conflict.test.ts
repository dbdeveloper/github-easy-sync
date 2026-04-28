import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  readVaultFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeRemoteFile,
  writeVaultFile,
} from "../../helpers";

// E3 — atomic plugin .js conflict, resolved by manifest version.
//
// Setup: a fake third-party plugin folder under <configDir>/plugins/
// is on both sides. Local has v1.0.0; remote has v1.2.0 — both the
// main.js and manifest.json differ accordingly. classifyForConflict
// returns "plugin-js" for the .js, so resolveAtomicConflicts kicks
// in: read both manifest.jsons, compareSemver picks the higher
// version, that side wins, no user UI.
//
// We don't bother with our own plugin folder (.obsidian/plugins/
// github-gitless-sync) because the per-self strict .gitignore
// blocks anything other than the four canonical files. Easier to
// fixture an unrelated plugin id instead.
describe.skipIf(!integrationEnabled())(
  "E3 — atomic plugin-js conflict resolved by manifest version",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("e3");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "newer remote version wins, no modal fires",
      async () => {
        // Fake third-party plugin id — anything other than ours.
        const otherPluginId = "fake-plugin";
        const pluginRoot = `.obsidian/plugins/${otherPluginId}`;
        const mainJsPath = `${pluginRoot}/main.js`;
        const manifestJsonPath = `${pluginRoot}/manifest.json`;

        const localMainJs = "// fake plugin v1.0.0\nmodule.exports = {};\n";
        const localManifest = JSON.stringify(
          { id: otherPluginId, name: "Fake", version: "1.0.0" },
          null,
          2,
        );
        const remoteMainJs = "// fake plugin v1.2.0\nmodule.exports = { newer: true };\n";
        const remoteManifest = JSON.stringify(
          { id: otherPluginId, name: "Fake", version: "1.2.0" },
          null,
          2,
        );

        client = createClient({
          branch,
          deviceName: "e3-test",
          syncConfigDir: true,
          // Plugin-js conflict must be resolved atomically — these
          // would only fire on a regression that escalates to UI.
          onConflicts: async () => {
            throw new Error("E3 unexpectedly triggered the text-conflict modal");
          },
          onAmbiguous: async () => {
            throw new Error("E3 unexpectedly triggered the init-state modal");
          },
        });

        // Prime: client pushes the local v1.0.0 versions.
        await writeVaultFile(client.vault, mainJsPath, localMainJs);
        await writeVaultFile(client.vault, manifestJsonPath, localManifest);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Web-UI overwrites both files with v1.2.0.
        await writeRemoteFile(
          branch,
          mainJsPath,
          remoteMainJs,
          "E3: bump fake plugin to v1.2.0 (main.js)",
        );
        await writeRemoteFile(
          branch,
          manifestJsonPath,
          remoteManifest,
          "E3: bump fake plugin to v1.2.0 (manifest.json)",
        );

        // Sync — atomic resolver should pick the v1.2.0 side.
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Local main.js should now hold the v1.2.0 content.
        const finalLocalMainJs = await readVaultFile(client.vault, mainJsPath);
        expect(finalLocalMainJs).toBe(remoteMainJs);

        // Remote unchanged at v1.2.0.
        const finalRemoteMainJs = await readRemoteFile(
          branch,
          mainJsPath,
          undefined,
        );
        expect(finalRemoteMainJs).toBe(remoteMainJs);
      },
      120_000,
    );
  },
);
