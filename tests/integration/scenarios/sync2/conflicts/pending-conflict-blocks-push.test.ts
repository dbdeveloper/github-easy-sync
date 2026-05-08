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
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Etap 6.5 — `enqueueOrMerge` filters out file changes whose path
// has an active conflict record. This test pre-creates a conflict,
// then edits BOTH the conflicted path and a clean path, and asserts
// only the clean path lands on GitHub. After the conflict is
// resolved (sibling delete), the next sync includes the previously-
// blocked path.

describe.skipIf(!integrationEnabled())(
  "sync2 conflict — pending-conflict path blocked from push, unblocks on resolve",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-conflict-block");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "edits to a pending-conflict path stay local; clean path goes through",
      async () => {
        // Seed two files. The first becomes our conflict; the second
        // is a control to confirm sync still works for clean paths.
        await writeRemoteFile(
          branch,
          "blocked.md",
          "shared baseline blocked\n",
          "[seed] blocked",
        );
        await writeRemoteFile(
          branch,
          "clean.md",
          "shared baseline clean\n",
          "[seed] clean",
        );
        client = await createSync2Client({
          onConflict: async () => ({ kind: "deferred" }),
          branch,
        });
        await sync2AllAndAssertNoErrors(client);

        // Trigger the conflict on blocked.md.
        fs.writeFileSync(
          path.join(client.vaultPath, "blocked.md"),
          "ours-blocked-v1\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "blocked.md",
          "theirs-blocked\n",
          "[web] divergent",
        );
        await sync2AllAndAssertNoErrors(client);
        // Now blocked.md is a pending conflict.
        expect(client.conflictStore.hasPending("blocked.md")).toBe(true);

        // User edits BOTH the conflicted file and a clean one, then
        // syncs again. The clean edit should propagate; the
        // conflicted edit should NOT.
        fs.writeFileSync(
          path.join(client.vaultPath, "blocked.md"),
          "ours-blocked-v2\n",
          "utf8",
        );
        fs.writeFileSync(
          path.join(client.vaultPath, "clean.md"),
          "clean-edited-from-test\n",
          "utf8",
        );
        await sync2AllAndAssertNoErrors(client);

        // Remote: clean.md got the new edit; blocked.md stayed put.
        expect(await readRemoteFile(branch, "clean.md")).toBe(
          "clean-edited-from-test\n",
        );
        expect(await readRemoteFile(branch, "blocked.md")).toBe(
          "theirs-blocked\n",
        );

        // Resolve via sibling delete, then sync. blocked.md should
        // now propagate ours-blocked-v2.
        const records = client.conflictStore.forPath("blocked.md");
        expect(records).toHaveLength(1);
        const siblingPath = records[0].siblingPath;
        fs.rmSync(path.join(client.vaultPath, siblingPath));
        await client.conflictStore.notifySiblingDeleted(siblingPath);

        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "blocked.md")).toBe(
          "ours-blocked-v2\n",
        );
      },
      300_000,
    );
  },
);
