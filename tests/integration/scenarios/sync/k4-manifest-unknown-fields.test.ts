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
  writeRemoteFile,
  writeVaultFile,
} from "../../helpers";

// K4 — forward-compat: remote manifest carries fields the running
// version doesn't recognize.
//
// JSON.parse passes through unknown keys; the Metadata interface
// is just a structural type, no runtime-validating schema. So an
// older Obsidian instance reading a manifest written by a newer
// instance must:
//   1. Not crash on the unknown keys.
//   2. Run a normal sync.
// What it WON'T do: preserve the unknown fields when it next writes
// the manifest. commitSync serializes the in-memory `metadataStore.
// data` object, which only carries fields the running version
// knows. That's expected behavior — we can't sensibly forward
// fields we don't understand, and risking that we corrupt them
// would be worse than dropping them.
//
// Sequence:
//   1. Prime branch normally.
//   2. Web-UI overwrite the manifest with the same content + an
//      extra `experimentalFeature: { foo: "bar" }` key.
//   3. Add a local edit. Sync.
//   4. Assert: no error notice, new file landed on remote, sync
//      completed without complaining about the extra key.
//
// We don't assert that the extra key is preserved post-sync — see
// the rationale above.
describe.skipIf(!integrationEnabled())(
  "K4 — unknown manifest fields don't break sync (forward compat)",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("k4");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "manifest with experimentalFeature key syncs cleanly",
      async () => {
        const manifestPath = ".obsidian/github-sync-metadata.json";

        client = createClient({ branch, deviceName: "k4-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(
          client.vault,
          "Notes/k4-prime.md",
          "prime.\n",
        );
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const original = await readRemoteFile(branch, manifestPath);
        const manifest = JSON.parse(original) as Record<string, unknown>;

        // Inject fields the running plugin doesn't know about.
        // Both a top-level key and a nested object so the test
        // covers both shallow and structured unknown content.
        const augmented = JSON.stringify({
          ...manifest,
          experimentalFeature: { foo: "bar" },
          futureSchemaVersion: 99,
        });
        await writeRemoteFile(
          branch,
          manifestPath,
          augmented,
          "K4: inject unknown fields",
        );

        // ---- normal sync flow ----------------------------------
        const newNote = "Notes/k4-after-unknown.md";
        const newContent = "uploaded after augmenting the manifest.\n";
        await writeVaultFile(client.vault, newNote, newContent);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const remote = await listRemoteFiles(branch);
        expect(remote).toContain(newNote);
        expect(await readRemoteFile(branch, newNote)).toBe(newContent);
      },
      240_000,
    );
  },
);
