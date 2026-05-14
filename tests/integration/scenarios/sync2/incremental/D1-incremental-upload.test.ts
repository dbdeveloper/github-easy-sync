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
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// D1 — post-adoption incremental upload. After lastSync is set, the
// second sync click finds local edits + new files via findChanges
// and pushes them in a single commit. Smoke-test that the nominal
// path stays working — most other suites depend on this.

describe.skipIf(!integrationEnabled())(
  "sync2 D1 — incremental upload (local edits + adds)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d1-incremental-upload");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "edit + add after prime → second sync lifts both to remote in one commit",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("alpha.md", "alpha v1\n");
        await sync2AllAndAssertNoErrors(client);

        // Prime confirmed: alpha.md on remote.
        expect(await readRemoteFile(branch, "alpha.md")).toBe("alpha v1\n");

        // Edit alpha, add beta.
        await client.vault.adapter.write("alpha.md", "alpha v2\n");
        await client.vault.adapter.write("Notes/beta.md", "beta v1\n");

        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "alpha.md")).toBe("alpha v2\n");
        expect(await readRemoteFile(branch, "Notes/beta.md")).toBe(
          "beta v1\n",
        );
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).toContain("alpha.md");
        expect(remoteFiles).toContain("Notes/beta.md");
      },
      210_000,
    );
  },
);
