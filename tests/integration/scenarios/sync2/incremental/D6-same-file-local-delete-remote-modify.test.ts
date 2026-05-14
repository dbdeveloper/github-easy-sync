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
  listRemoteFiles,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// D6 — same file: local-delete vs remote-modify. Per the user's
// rule, local intent (delete) wins: file removed on remote.
//
// sync2's pull-side applyRemoteAddOrModify (sync2-manager.ts:667)
// already encodes this: when the remote claims "added/modified" on
// a path the local saw as "deleted" (no record-sync), the local
// stays missing AND no recordSync runs, so the next push surfaces
// the deletion. Net: file disappears on the remote in the same
// sync cycle.

describe.skipIf(!integrationEnabled())(
  "sync2 D6 — same file: local delete + remote modify → delete wins",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d6-same-del-vs-mod");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "delete x locally + modify x remotely → x gone on remote and local",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("x.md", "x v1\n");
        await sync2AllAndAssertNoErrors(client);

        // Local: delete x.md.
        await client.vault.adapter.remove("x.md");
        // Remote: another device modified x.md.
        await writeRemoteFile(
          branch,
          "x.md",
          "x v2 from other device\n",
          "[other] modify x.md",
        );

        await sync2AllAndAssertNoErrors(client);

        // Final state: x.md gone on both sides.
        expect(fs.existsSync(path.join(client.vaultPath, "x.md"))).toBe(false);
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain("x.md");
      },
      240_000,
    );
  },
);
