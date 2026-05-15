import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getBranchHead,
  getDefaultBranchHead,
  integrationEnabled,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Stage 6.6 — convergence + idempotency. The first syncAll after a
// noisy remote pull should converge in exactly two commits (the
// remote's noisy commit + sync2's auto-republish). The second
// syncAll, with no further changes anywhere, must produce ZERO new
// commits — otherwise we have a thrashing loop where every sync
// re-normalizes and re-pushes.

describe.skipIf(!integrationEnabled())(
  "sync2 normalization — second sync after normalize is a no-op",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-norm-idem");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "double sync after normalize-republish: no thrashing loop",
      async () => {
        // Web puts a CRLF file on the branch.
        await writeRemoteFile(
          branch,
          "doc.md",
          "alpha\r\nbeta\r\n",
          "[web] CRLF",
        );

        client = await createSync2Client({ branch });

        // First sync: pulls + auto-republishes. Branch HEAD must
        // advance (the auto-republish commits a new tree).
        const headBefore = await getBranchHead(branch);
        await sync2AllAndAssertNoErrors(client);
        const headAfterFirst = await getBranchHead(branch);
        expect(headAfterFirst).not.toBe(headBefore);

        // Second sync: nothing changed locally, nothing on remote.
        // HEAD must stay put — no extra commits, no thrashing.
        await sync2AllAndAssertNoErrors(client);
        const headAfterSecond = await getBranchHead(branch);
        expect(headAfterSecond).toBe(headAfterFirst);
      },
      180_000,
    );
  },
);
