import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  AmbiguousStateInfo,
} from "../../../../src/sync-manager";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  getRemoteFileSha,
  integrationEnabled,
  readRemoteFile,
  syncAndCollectErrors,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// B3: real conflict during adoption — same path on both sides with
// divergent content. compareForAdoption marks the path as conflicting,
// shouldAutoAdopt returns false, executeInitAction routes through
// "ambiguous", which calls onAmbiguous to ask the user. We exercise
// two of the three answers:
//   1. cancel → sync throws "Sync cancelled by user", no remote
//      mutation, no local mutation.
//   2. overwrite-remote (a.k.a. "Keep local") → first-sync-from-local
//      pushes our content, replacing the remote.
describe.skipIf(!integrationEnabled())(
  "B3 — adoption with real conflict requires user decision",
  () => {
    let client1: TestClient | undefined;
    let client2: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("b3");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client1?.cleanup();
      client2?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "cancel keeps both sides untouched, then overwrite-remote pushes local",
      async () => {
        const conflictedPath = "Notes/conflicted.md";
        const remoteContent = "## Remote version\nThis lives on GitHub.\n";
        const localContent = "## Local version\nThis lives on the device.\n";

        // ---- client1: publish "remote" version ------------------
        client1 = createClient({ branch, deviceName: "b3-client1" });
        await writeVaultFile(client1.vault, conflictedPath, remoteContent);
        await client1.sync.loadMetadata();
        await syncAndAssertNoErrors(client1);

        const remoteShaBefore = await getRemoteFileSha(branch, conflictedPath);
        expect(remoteShaBefore, "client1's push should have landed").not.toBeNull();

        // ---- client2: same path, different content -------------
        // Step 1: sync with "cancel" — should leave everything
        // untouched on both sides.
        let ambiguousCallCount = 0;
        let lastAnalysis: AmbiguousStateInfo | undefined;

        const makeClient = (decision: "cancel" | "overwrite-remote") =>
          createClient({
            branch,
            deviceName: "b3-client2",
            onAmbiguous: async (info) => {
              ambiguousCallCount++;
              lastAnalysis = info;
              return decision;
            },
          });

        client2 = makeClient("cancel");
        await writeVaultFile(client2.vault, conflictedPath, localContent);
        await client2.sync.loadMetadata();
        const cancelErrors = await syncAndCollectErrors(client2);
        expect(
          cancelErrors.some((e) => e.includes("cancelled by user")),
          `expected the cancel notice; got: ${cancelErrors.join(" | ")}`,
        ).toBe(true);
        expect(ambiguousCallCount).toBe(1);
        expect(lastAnalysis?.analysis.conflicting).toContain(conflictedPath);

        // Remote SHA must be unchanged after cancel.
        const remoteShaAfterCancel = await getRemoteFileSha(branch, conflictedPath);
        expect(remoteShaAfterCancel).toBe(remoteShaBefore);

        // Step 2: re-sync with "overwrite-remote" (Keep local).
        // SyncManager.sync() catches the cancel-throw and clears the
        // syncing flag in finally, so a second call goes through.
        client2.cleanup();
        client2 = makeClient("overwrite-remote");
        // Re-seed the local vault — cleanup() wiped the previous
        // tempdir.
        await writeVaultFile(client2.vault, conflictedPath, localContent);
        await client2.sync.loadMetadata();
        await syncAndAssertNoErrors(client2);

        // Remote should now hold the local version.
        const remoteAfterOverwrite = await readRemoteFile(branch, conflictedPath);
        expect(remoteAfterOverwrite).toBe(localContent);
      },
      180_000,
    );
  },
);
