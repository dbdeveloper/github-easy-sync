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
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  removeRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// D7 — same file: local-modify vs remote-delete. Per the user's
// rule, local intent (modify) wins: file resurrects on remote with
// the local content.
//
// sync2's pull-side applyRemoteDeletion (sync2-manager.ts:904)
// already encodes this: when local has its own changes, the
// deletion is NOT applied locally and no recordSync runs, so the
// follow-up push lifts the local copy back onto the remote.

describe.skipIf(!integrationEnabled())(
  "sync2 D7 — same file: local modify + remote delete → modify wins, resurrection",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d7-same-mod-vs-del");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "modify x locally + delete x remotely → x resurrects on remote with local content",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("x.md", "x v1\n");
        await sync2AllAndAssertNoErrors(client);

        // Local: modify x.md.
        await client.vault.adapter.write("x.md", "x v2 local\n");
        // Remote: another device deleted x.md.
        await removeRemoteFile(branch, "x.md", "[other] delete x.md");

        await sync2AllAndAssertNoErrors(client);

        // x.md is back on remote with the local content.
        expect(await readRemoteFile(branch, "x.md")).toBe("x v2 local\n");
        // Local still has it.
        expect(
          fs.readFileSync(path.join(client.vaultPath, "x.md"), "utf8"),
        ).toBe("x v2 local\n");
      },
      240_000,
    );
  },
);
