import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getBranchHead,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// text canonicalisation — multi-device convergence. Device A authors a CRLF file
// and pushes (push-side write-back canonicalizes both A's local
// copy and what lands on GitHub). Device B pulls — sees LF locally
// straight away. B's next sync, with no further changes, must be a
// no-op: no thrashing across the two devices' canonicalization
// pipelines.

describe.skipIf(!integrationEnabled())(
  "sync2 normalization — A pushes CRLF, B pulls LF, idle convergence",
  () => {
    let clientA: Sync2TestClient | undefined;
    let clientB: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-norm-multi");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      clientA?.cleanup();
      clientB?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "A pushes CRLF → B pulls LF → B's idle sync is a no-op",
      async () => {
        // ---- A: prime + author a CRLF file + push -----------
        clientA = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(clientA);
        fs.writeFileSync(
          path.join(clientA.vaultPath, "shared.md"),
          "from-A\r\nline2\r\n",
          "utf-8",
        );
        await sync2AllAndAssertNoErrors(clientA);

        // GitHub got the canonical version (push-side write-back).
        expect(await readRemoteFile(branch, "shared.md")).toBe(
          "from-A\nline2\n",
        );
        // A's local copy was rewritten in place to canonical too.
        expect(
          fs.readFileSync(
            path.join(clientA.vaultPath, "shared.md"),
            "utf8",
          ),
        ).toBe("from-A\nline2\n");

        // ---- B: pull → sees LF locally --------------------
        clientB = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(clientB);
        const bLocal = fs.readFileSync(
          path.join(clientB.vaultPath, "shared.md"),
          "utf8",
        );
        expect(bLocal).toBe("from-A\nline2\n");

        // ---- B: idle re-sync with no changes anywhere -----
        const headBeforeIdle = await getBranchHead(branch);
        await sync2AllAndAssertNoErrors(clientB);
        const headAfterIdle = await getBranchHead(branch);
        expect(headAfterIdle).toBe(headBeforeIdle);

        // And A re-syncing is also a no-op.
        const headBeforeA = await getBranchHead(branch);
        await sync2AllAndAssertNoErrors(clientA);
        const headAfterA = await getBranchHead(branch);
        expect(headAfterA).toBe(headBeforeA);
      },
      300_000,
    );
  },
);
