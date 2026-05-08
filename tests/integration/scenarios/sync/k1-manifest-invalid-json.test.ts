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
  syncAndCollectErrors,
  TestClient,
  uniqueBranchName,
  writeRemoteFile,
  writeVaultFile,
} from "../../helpers";

// K1 — remote manifest is non-JSON garbage. Plugin must surface a
// readable error notice instead of crashing, and the user's manual
// recovery path (restore valid manifest content on remote) must
// converge cleanly.
//
// Where it explodes: sync-state.ts:273
//   const manifest: Metadata = JSON.parse(decodeBase64String(blob.content));
// No try/catch around the parse — a SyntaxError bubbles up through
// analyzeRemoteState → dispatchSync → SyncManager.sync()'s catch
// block, which wraps the message into an "Error syncing." Notice.
//
// Sequence:
//   1. Prime branch with one note. Capture the well-formed manifest
//      blob the local client wrote — used as the recovery payload
//      in step 4.
//   2. Web-UI overwrite the remote manifest with a non-JSON string.
//   3. Sync — expect an error notice. Remote tree's user files
//      should still be present (only the manifest blob was touched).
//   4. Manual recovery: restore the remote manifest to the original
//      JSON content via writeRemoteFile.
//   5. Sync again — expect convergence and a successful incremental
//      upload of a new local note.
describe.skipIf(!integrationEnabled())(
  "K1 — invalid-JSON remote manifest: error notice + manual recovery",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("k1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "JSON.parse failure surfaces; restoring manifest converges next sync",
      async () => {
        const manifestPath = ".obsidian/github-easy-sync-metadata.json";
        const seedNote = "Notes/k1-prime.md";
        const seedContent = "prime.\n";

        client = createClient({ branch, deviceName: "k1-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, seedNote, seedContent);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Snapshot the well-formed manifest before we corrupt it.
        const goodManifest = await readRemoteFile(branch, manifestPath);
        expect(() => JSON.parse(goodManifest)).not.toThrow();

        // ---- corrupt the manifest blob -------------------------
        await writeRemoteFile(
          branch,
          manifestPath,
          "not-json {{{ unclosed --- definitely not valid",
          "K1: corrupt manifest",
        );

        // ---- sync surfaces the error ---------------------------
        await client.sync.loadMetadata();
        const errors = await syncAndCollectErrors(client);
        expect(
          errors.length,
          `expected an error notice on the JSON.parse failure; got: ${errors.join(" | ")}`,
        ).toBeGreaterThan(0);

        // User-data on remote is still intact — only the manifest
        // blob was touched, the tree itself wasn't rewritten.
        const treeMidCorrupt = await listRemoteFiles(branch);
        expect(treeMidCorrupt).toContain(seedNote);
        expect(await readRemoteFile(branch, seedNote)).toBe(seedContent);

        // ---- manual recovery -----------------------------------
        // The user's escape hatch is "restore the manifest blob".
        // Easiest path in the wild is to commit a known-good copy
        // from another device, the plugin log, or a backup. We
        // simulate by writing back the manifest we snapshotted.
        await writeRemoteFile(
          branch,
          manifestPath,
          goodManifest,
          "K1: restore valid manifest",
        );

        // Add a new local edit so the next sync has real work to
        // do; otherwise we couldn't tell the difference between
        // "recovered cleanly" and "no-op".
        const recoveredNote = "Notes/k1-after-recovery.md";
        const recoveredContent = "lands after manifest restore.\n";
        await writeVaultFile(client.vault, recoveredNote, recoveredContent);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const remote = await listRemoteFiles(branch);
        expect(remote).toContain(recoveredNote);
        expect(await readRemoteFile(branch, recoveredNote)).toBe(recoveredContent);
      },
      300_000,
    );
  },
);
