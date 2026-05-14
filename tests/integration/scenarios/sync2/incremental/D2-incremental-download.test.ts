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
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// D2 — post-adoption incremental download. Another device pushed a
// new file AND modified an existing one on the branch; sync2's
// pullIfNeeded must pick both up via the GitHub compare diff and
// apply each to the local vault.

describe.skipIf(!integrationEnabled())(
  "sync2 D2 — incremental download (remote edits + adds)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d2-incremental-download");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "remote modifies one file + adds another → next sync pulls both",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("shared.md", "v1\n");
        await sync2AllAndAssertNoErrors(client);

        // Another device touches the branch directly via the Contents
        // API: modifies shared.md and adds news.md.
        await writeRemoteFile(
          branch,
          "shared.md",
          "v2 from other device\n",
          "[other] modify shared.md",
        );
        await writeRemoteFile(
          branch,
          "news.md",
          "fresh remote note\n",
          "[other] add news.md",
        );

        // Sync — pulls both remote changes into the vault.
        await sync2AllAndAssertNoErrors(client);

        const sharedLocal = fs.readFileSync(
          path.join(client.vaultPath, "shared.md"),
          "utf8",
        );
        expect(sharedLocal).toBe("v2 from other device\n");
        const newsLocal = fs.readFileSync(
          path.join(client.vaultPath, "news.md"),
          "utf8",
        );
        expect(newsLocal).toBe("fresh remote note\n");
      },
      210_000,
    );
  },
);
