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
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import { mergeIntoOne } from "../../../../../src/sync2/conflict-merge-all";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Etap 6.5 — markdown "merge into one" auto-resolution. The user
// picks the third button on the modal; sync2 builds an Obsidian
// callout block under the original with theirs content, writes the
// merged document locally, and pushes to GitHub in the same sync.

describe.skipIf(!integrationEnabled())(
  "sync2 conflict — merge into one (markdown only)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-conflict-mio");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "merged document lands locally + on GitHub with the theirs callout",
      async () => {
        await writeRemoteFile(
          branch,
          "doc.md",
          "shared baseline\n",
          "[seed] baseline",
        );

        // Programmatic onConflict that mimics the modal's
        // "merge-into-one" branch. Real main.ts does the same: take
        // ours, append theirs as a `> [!info]` callout.
        client = await createSync2Client({
          onConflict: async (a) => {
            const merged = mergeIntoOne(a.ours, [
              {
                content: a.theirs,
                deviceLabel: "GitHub",
                ts: 1715000000000, // fixed for deterministic comparison
              },
            ]);
            return { kind: "merged-into-one", content: merged };
          },
          branch,
        });
        await sync2AllAndAssertNoErrors(client);

        // Diverge.
        fs.writeFileSync(
          path.join(client.vaultPath, "doc.md"),
          "ours version with extra notes\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "doc.md",
          "theirs version with different notes\n",
          "[web] divergent",
        );

        await sync2AllAndAssertNoErrors(client);

        // Local file is the merged callout document.
        const local = fs.readFileSync(
          path.join(client.vaultPath, "doc.md"),
          "utf8",
        );
        expect(local).toContain("ours version with extra notes");
        expect(local).toContain("> [!info] Changing 1 — from GitHub");
        expect(local).toContain("> theirs version with different notes");

        // Remote was pushed with the same merged content.
        const remote = await readRemoteFile(branch, "doc.md");
        expect(remote).toBe(local);

        // No pending conflict — merge-into-one resolves immediately.
        expect(client.conflictStore.hasPending("doc.md")).toBe(false);
      },
      300_000,
    );
  },
);
