import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  getRemoteFileSha,
  integrationEnabled,
  readVaultFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeRemoteFile,
  writeVaultFile,
} from "../../helpers";

// H1 — a file ALREADY tracked on both sides gets modified through
// the GitHub web UI between two of the client's syncs.
//
// Sister test to D2 — D2 covers a remote ADD (file new to remote),
// H1 covers a remote MODIFY (file already in our manifest with an
// older SHA). The code paths differ:
//   * D2 hits the "remote-only" forEach loop in determineSyncActions
//     (line 1752): no localFile entry, push download.
//   * H1 hits the forward SHA refresh in analyzeRemoteState (line
//     1083: tree SHA differs from manifest SHA → update
//     remoteMetadata.sha) AND determineSyncActions's no-local-change
//     download branch (line 1745: localSHA matches localFile.sha,
//     but remoteFile.sha differs → download).
// Without the SHA refresh, determineSyncActions would see
// remoteFile.sha === localFile.sha (both stale at the manifest's
// pre-edit value) and silently skip the file even though the tree
// has the new content.
//
// Sequence:
//   1. Client primes branch with foo.md, syncs.
//   2. Web-UI overwrites foo.md (writeRemoteFile) with new content.
//   3. Client syncs. Plugin detects diverging remote SHA, downloads
//      new content, updates local manifest's SHA so the next sync
//      is a no-op (no infinite re-download loop).
//
// Asserts: local content matches the web-UI version after the
// second sync; client.metadataStore.data.files[foo.md].sha matches
// the new remote SHA (verifies the SHA refresh actually persisted).
describe.skipIf(!integrationEnabled())(
  "H1 — web-UI modify of an existing file between syncs",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("h1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "downloads remote modification + refreshes local SHA so next sync is a no-op",
      async () => {
        const target = "Notes/h1-target.md";
        const original = "# original\nseed content from local.\n";
        const remoteEdit = "# edited via web UI\nremote rewrote this.\n";

        // ---- prime: client writes foo.md and syncs ---------------
        client = createClient({ branch, deviceName: "h1-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, target, original);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const initialSha = await getRemoteFileSha(branch, target);
        expect(initialSha).not.toBeNull();

        // ---- web-UI edit between syncs --------------------------
        await writeRemoteFile(branch, target, remoteEdit, "H1: web-UI overwrite");
        const newRemoteSha = await getRemoteFileSha(branch, target);
        expect(
          newRemoteSha,
          "remote SHA should change after web-UI overwrite",
        ).not.toBe(initialSha);

        // ---- second sync downloads the new content --------------
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        expect(await readVaultFile(client.vault, target)).toBe(remoteEdit);

        // Manifest's SHA must now match the new remote blob SHA.
        // If the analyzeRemoteState reconcile didn't refresh it, the
        // download still works once but every subsequent sync would
        // emit a redundant download, since determineSyncActions would
        // keep seeing remoteFile.sha != localFile.sha forever.
        const metadataStore = (client.sync as unknown as {
          metadataStore: {
            data: { files: Record<string, { sha: string | null }> };
          };
        }).metadataStore;
        expect(
          metadataStore.data.files[target].sha,
          "local manifest SHA should equal the post-edit remote SHA",
        ).toBe(newRemoteSha);

        // ---- third sync should be a no-op (no notice fires) -----
        // If this passes silently it confirms the SHA refresh stuck.
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        expect(await readVaultFile(client.vault, target)).toBe(remoteEdit);
      },
      180_000,
    );
  },
);
