import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  failOnNthMatch,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  listRemoteFiles,
  readRemoteFile,
  readVaultFile,
  syncAndAssertNoErrors,
  syncAndCollectErrors,
  TestClient,
  uniqueBranchName,
  writeRemoteFile,
  writeVaultFile,
} from "../../helpers";

// H2 — recovery from a failed updateBranchHead.
//
// In production this 422s if a concurrent push moved the branch
// head between commitSync's getBranchHeadSha (sync-manager.ts:1979)
// and updateBranchHead (line 1987) — a microsecond window the
// plugin re-reads HEAD just before commit. Reproducing that exact
// race requires an async fault injector capable of mid-request
// out-of-band side effects, which we don't have. What we CAN test
// — and what actually matters from the user's perspective — is
// that the plugin recovers cleanly after a failed updateBranchHead:
// the next sync attempt converges, and out-of-band remote changes
// are discovered.
//
// Sequence:
//   1. Client primes branch with foo.md, syncs.
//   2. Client locally edits foo.md.
//   3. Inject a one-shot failure on PATCH /git/refs/heads/<branch>
//      — that's the updateBranchHead endpoint. Sync hits it once,
//      surfaces an error notice, leaves remote tree unchanged.
//   4. Clear the injector. Out-of-band: web-UI adds a new file
//      (writeRemoteFile) so the branch HEAD moves.
//   5. Sync again. The plugin should:
//      - notice the new tree state (out-of-band file in tree)
//      - re-attempt the upload of foo.md (still pending in local
//        manifest)
//      - download the out-of-band file
//      - emit no error notices.
//
// Asserts after recovery: foo.md on remote with new local content;
// out-of-band file present locally; no leftover error state.
describe.skipIf(!integrationEnabled())(
  "H2 — recovery from a failed updateBranchHead",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("h2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      installRequestFaultInjector(null);
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "next sync after a 422-style ref-update failure converges",
      async () => {
        const target = "Notes/h2-target.md";
        const original = "# original\nseed.\n";
        const localEdit = "# local edit\nlands after recovery.\n";
        const oobPath = "Notes/h2-out-of-band.md";
        const oobContent = "# out of band\nadded between failed + retry.\n";

        // ---- prime branch with target, both sides synced --------
        client = createClient({ branch, deviceName: "h2-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, target, original);
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // ---- local edit + injected failure ----------------------
        await writeVaultFile(client.vault, target, localEdit);
        installRequestFaultInjector(
          failOnNthMatch(
            (url, method) =>
              method === "PATCH" &&
              url.includes(`/git/refs/heads/${encodeURIComponent(branch)}`),
            1,
            "H2: simulated updateBranchHead failure",
          ),
        );

        await client.sync.loadMetadata();
        const errors = await syncAndCollectErrors(client);
        installRequestFaultInjector(null);
        expect(
          errors.some((e) => e.includes("simulated updateBranchHead failure")),
          `expected simulated failure notice; got: ${errors.join(" | ")}`,
        ).toBe(true);

        // ---- out-of-band: add a file via web UI -----------------
        // Ensures the recovery path actually picks up new remote
        // state, not just a clean retry of the same tree.
        await writeRemoteFile(branch, oobPath, oobContent, "H2: out-of-band add");

        // ---- recovery sync --------------------------------------
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Local edit landed on remote.
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).toContain(target);
        expect(await readRemoteFile(branch, target)).toBe(localEdit);
        // Out-of-band file landed locally.
        expect(remoteFiles).toContain(oobPath);
        expect(await readVaultFile(client.vault, oobPath)).toBe(oobContent);
      },
      240_000,
    );
  },
);
