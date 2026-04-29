import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getBranchHead,
  getDefaultBranchHead,
  integrationEnabled,
  syncAndCollectErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// J3 — wrong owner (or repo) in settings → 404 → readable error.
//
// Common user-config mistake: typo in the repo URL on first setup.
// The plugin must surface a status-bearing error notice that lets
// users grep their logs and figure out the misconfiguration. We
// don't pin the exact wording — that's brittle copy — just that
// some "404" or "Failed to" signal makes it through.
//
// We mutate `client.settings.githubOwner` to a name with a random
// suffix so there's zero chance it collides with a real account.
// The 404 propagates from getRepoContent or getBranchHeadSha (one
// of which fires first in dispatchSync's analyzeRemoteState path).
// 404 is non-retriable in the post-J2 retry condition (only 422,
// 429, 5xx retry), so the error surfaces immediately rather than
// after retryUntil drains its budget.
describe.skipIf(!integrationEnabled())(
  "J3 — wrong githubOwner produces a clear error notice",
  () => {
    let client: TestClient | undefined;
    let branch: string;
    let realOwner: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("j3");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      if (client && realOwner) client.settings.githubOwner = realOwner;
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "404 on a typo'd owner surfaces as a Notice; remote untouched",
      async () => {
        client = createClient({ branch, deviceName: "j3-test" });
        realOwner = client.settings.githubOwner;
        await client.sync.loadMetadata();
        await syncAndCollectErrors(client); // prime: succeeds
        await writeVaultFile(client.vault, "Notes/j3-x.md", "x.\n");
        await client.sync.loadMetadata();
        await syncAndCollectErrors(client); // succeeds — initial sync done

        const baselineHead = await getBranchHead(branch);
        expect(baselineHead).not.toBeNull();

        // ---- typo'd owner --------------------------------------
        // Random suffix removes any chance of hitting a real
        // user/org by accident. github_user namespace allows up to
        // 39 chars; we stay safely under that.
        client.settings.githubOwner =
          `nonexistent-user-${Date.now().toString(36)}`;

        await writeVaultFile(client.vault, "Notes/j3-y.md", "y — should not land.\n");
        await client.sync.loadMetadata();
        const errors = await syncAndCollectErrors(client);
        expect(
          errors.length,
          `expected at least one error notice on the typo'd owner; got: ${errors.join(" | ")}`,
        ).toBeGreaterThan(0);
        // Best-effort substring check: at least one notice should
        // mention the failure shape so users can grep the log.
        const hint = errors.join("\n");
        expect(
          /404|Failed/i.test(hint),
          `expected the error notice to mention 404 / 'Failed'; got: ${hint}`,
        ).toBe(true);

        // Remote head is unchanged on the REAL repo — typo means
        // no traffic ever reached the right place. (Sanity.)
        const headAfter = await getBranchHead(branch);
        expect(
          headAfter,
          "branch head should not advance when sync hit 404 on owner",
        ).toBe(baselineHead);
      },
      240_000,
    );
  },
);
