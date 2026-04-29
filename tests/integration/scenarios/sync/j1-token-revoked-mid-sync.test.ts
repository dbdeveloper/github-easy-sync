import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getBranchHead,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  syncAndAssertNoErrors,
  syncAndCollectErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// J1 — token rotation while a session is using stale credentials.
//
// User scenario: token gets revoked or scrubbed in GitHub settings.
// On the next sync attempt, every API call returns 401. The plugin
// must (a) surface the error via Notice without crashing, (b) leave
// remote state untouched (no half-commits, no stranded blobs), and
// (c) recover seamlessly once the user pastes a fresh token.
//
// We simulate by mutating `client.settings.githubToken` to a
// definitely-invalid value (a syntactically-valid PAT shape that
// GitHub will reject). The settings reference is shared with
// SyncManager (helpers.ts:706 passes it by reference), so the
// next sync's headers() call (client.ts:68-74) sees the bad token.
//
// Sequence:
//   1. Prime: client syncs clean, writes a note, syncs again. Capture
//      the branch head SHA — this is the "untouched" baseline that
//      must survive the failed sync.
//   2. Stage another local edit that would change remote.
//   3. Mutate `githubToken` to the invalid value.
//   4. Sync — expect an error notice. Verify remote head is still
//      the pre-mutation baseline (no commit landed).
//   5. Restore the real token. Sync — expect success and the new
//      edit to land on remote.
describe.skipIf(!integrationEnabled())(
  "J1 — token revoked mid-flight; clean error + recovery on rotation",
  () => {
    let client: TestClient | undefined;
    let branch: string;
    let realToken: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("j1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      // Defensive token restore in case a test failed mid-mutation.
      if (client && realToken) client.settings.githubToken = realToken;
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "401 surfaces as a Notice, remote unchanged, recovery on token rotation",
      async () => {
        client = createClient({ branch, deviceName: "j1-test" });
        realToken = client.settings.githubToken;

        // ---- prime ----------------------------------------------
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        await writeVaultFile(client.vault, "Notes/j1-prime.md", "prime.\n");
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);
        const baselineHead = await getBranchHead(branch);
        expect(baselineHead).not.toBeNull();
        const baselineFiles = await listRemoteFiles(branch);

        // ---- stage another edit + revoke token -------------------
        const newPath = "Notes/j1-after-revoke.md";
        await writeVaultFile(
          client.vault,
          newPath,
          "should not land while token is bad.\n",
        );
        // PAT shape that's lexically valid but will not authenticate
        // against any repo. GitHub's response on that is 401, which
        // post-J2-refactor is non-retriable (isRetriableStatus excludes
        // 4xx other than 422/429), so the error surfaces immediately.
        client.settings.githubToken =
          "github_pat_invalid_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        await client.sync.loadMetadata();
        const errors = await syncAndCollectErrors(client);
        expect(
          errors.length,
          `expected at least one error notice with the bad token; got: ${errors.join(" | ")}`,
        ).toBeGreaterThan(0);
        // Don't pin to exact wording — just that something ended up
        // surfaced. Recovery is the main contract.

        // Remote unchanged — no commit, no stranded files.
        const headDuringRevoke = await getBranchHead(branch);
        expect(
          headDuringRevoke,
          "branch HEAD must not advance while sync was failing on auth",
        ).toBe(baselineHead);
        const filesDuringRevoke = await listRemoteFiles(branch);
        expect(
          filesDuringRevoke.sort(),
          "remote tree must match the pre-revoke baseline",
        ).toEqual(baselineFiles.sort());

        // ---- restore token + sync converges ----------------------
        client.settings.githubToken = realToken;
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        const recoveredFiles = await listRemoteFiles(branch);
        expect(recoveredFiles).toContain(newPath);
        const recoveredHead = await getBranchHead(branch);
        expect(
          recoveredHead,
          "recovery sync should advance HEAD past the baseline",
        ).not.toBe(baselineHead);
      },
      300_000,
    );
  },
);
