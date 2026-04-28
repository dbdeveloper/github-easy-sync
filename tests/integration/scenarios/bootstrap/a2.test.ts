import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  bootstrapEnabled,
  countBranchCommits,
  createClient,
  getBranchHead,
  listRemoteFiles,
  readRemoteFile,
  recreateRepo,
  requireBootstrapEnv,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
} from "../../helpers";

// A2 covers the routing where the vault has real user content and the
// remote is bare. State: local=has-content-no-manifest + remote=bare,
// resume=null → decideInitAction returns first-sync-from-local. The
// orchestrator runs bootstrapEmptyRepo first (seeds the .gitignore +
// manifest commit) and then firstSyncFromLocal (commits the user
// files in a second tree). This test confirms the full chain lands
// on the remote with content matching the local source.
describe.skipIf(!bootstrapEnabled())(
  "A2 — first-sync-from-local on a bare repo",
  () => {
    let client: TestClient;
    let branch: string;

    beforeEach(async () => {
      await recreateRepo(requireBootstrapEnv());
      // Brief pause so the freshly-created repo is fully consistent
      // before the test starts hitting it. Same hardening as A1.
      await new Promise((r) => setTimeout(r, 1500));
      branch = uniqueBranchName("a2");
    });

    afterEach(async () => {
      client?.cleanup();
    });

    it(
      "uploads vault notes + a binary alongside the bootstrap commit",
      async () => {
        const env = requireBootstrapEnv();
        client = createClient({ branch, deviceName: "a2-test", env });

        // Seed the vault BEFORE loadMetadata. We want these files to
        // be visible to the events listener / reconcileWithVault when
        // the plugin starts, so they end up in the metadata that
        // firstSyncFromLocal will iterate.
        await client.vault.adapter.write(
          "Notes/welcome-note.md",
          "# Hello from A2\n\nThis is a user-authored note.\n",
        );
        await client.vault.adapter.write(
          "Notes/nested/deep-note.md",
          "Nested content to verify directory creation works.\n",
        );
        // Tiny PNG (1x1 transparent) to exercise the binary upload
        // path: createBlob + tree entry by SHA, not inline content.
        const tinyPng = Buffer.from(
          "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f80f00000100015e1eb1a30000000049454e44ae426082",
          "hex",
        );
        await client.vault.adapter.writeBinary(
          "Notes/pixel.png",
          tinyPng.buffer.slice(
            tinyPng.byteOffset,
            tinyPng.byteOffset + tinyPng.byteLength,
          ) as ArrayBuffer,
        );

        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const head = await getBranchHead(branch, env);
        expect(head, `branch ${branch} should exist after sync`).not.toBeNull();

        // The remote tree should hold every user file plus the
        // infra commit's contents. Check this before commit count
        // so the failure message points at content, not history shape.
        const remoteFiles = await listRemoteFiles(branch, env);
        expect(remoteFiles).toContain(".gitignore");
        expect(remoteFiles).toContain(
          ".obsidian/github-sync-metadata.json",
        );
        expect(remoteFiles).toContain("Notes/welcome-note.md");
        expect(remoteFiles).toContain("Notes/nested/deep-note.md");
        expect(remoteFiles).toContain("Notes/pixel.png");

        // Branch must have exactly two commits: bootstrap (Initial
        // commit) + the firstSyncFromLocal follow-up.
        const commitCount = await countBranchCommits(branch, env);
        expect(commitCount).toBe(2);

        // Byte-level content check on a text file: the upload path
        // for text goes through createTree's inline `content` field
        // (not createBlob), so a regression there would surface as a
        // mismatch here.
        const remoteNote = await readRemoteFile(
          branch,
          "Notes/welcome-note.md",
          env,
        );
        expect(remoteNote).toBe(
          "# Hello from A2\n\nThis is a user-authored note.\n",
        );

        // Manifest sanity: lastSync stamped and per-device fields
        // stripped (same invariants as A1).
        const manifestText = await readRemoteFile(
          branch,
          ".obsidian/github-sync-metadata.json",
          env,
        );
        const manifest = JSON.parse(manifestText);
        expect(manifest.lastSync).toBeGreaterThan(0);
        expect(manifest.firstSyncFromLocalInProgress).toBeUndefined();
        expect(manifest.firstSyncFromRemoteInProgress).toBeUndefined();
        expect(manifest.pluginCreatedGitignores).toBeUndefined();
        expect(manifest.preExistingGitignoreShas).toBeUndefined();
        // Manifest knows about the user files we just pushed.
        expect(manifest.files["Notes/welcome-note.md"]).toBeDefined();
        expect(manifest.files["Notes/pixel.png"]).toBeDefined();
      },
      180_000,
    );
  },
);
