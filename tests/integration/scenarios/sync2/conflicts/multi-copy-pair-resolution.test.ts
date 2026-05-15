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

// Stage 6.5 — multi-copy resolution. Two consecutive deferred
// conflicts on the same path produce two sibling files. Resolving
// the first one (sibling A) leaves the second pending — sync still
// excludes the path. Resolving the second one finally unblocks the
// path for push. Pair-by-pair semantics, never 3+ panes.

describe.skipIf(!integrationEnabled())(
  "sync2 conflict — multi-copy: resolve siblings one at a time",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-conflict-multi");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "two deferred conflicts on one file → resolve both → final push goes through",
      async () => {
        await writeRemoteFile(
          branch,
          "shared.md",
          "v0 baseline\n",
          "[seed]",
        );
        client = await createSync2Client({
          onConflict: async () => ({ kind: "deferred" }),
          branch,
        });
        await sync2AllAndAssertNoErrors(client);

        // First conflict: ours v1, theirs v1.
        fs.writeFileSync(
          path.join(client.vaultPath, "shared.md"),
          "ours v1\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "shared.md",
          "theirs v1\n",
          "[web] divergent v1",
        );
        await sync2AllAndAssertNoErrors(client);
        expect(client.conflictStore.forPath("shared.md")).toHaveLength(1);

        // Second conflict: ours v2 (still local), theirs v2 (web).
        // The path is still pending (first conflict unresolved), so
        // the user editing locally and theirs editing on web again
        // produces a SECOND deferred record. Note: enqueueOrMerge
        // skipped ours v1 because of the pending conflict; ours v2
        // is what's on disk now.
        fs.writeFileSync(
          path.join(client.vaultPath, "shared.md"),
          "ours v2\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "shared.md",
          "theirs v2\n",
          "[web] divergent v2",
        );
        // Need a small wait to ensure ConflictStore generates a
        // distinct id (timestamp-based, ms-resolution). The "tick
        // forward on collision" logic also handles this, but a
        // 5ms sleep removes any flakiness.
        await new Promise((r) => setTimeout(r, 5));
        await sync2AllAndAssertNoErrors(client);
        const records = client.conflictStore.forPath("shared.md");
        expect(records).toHaveLength(2);

        // Resolve sibling 1 (older). Path stays pending because
        // sibling 2 is still there.
        fs.rmSync(path.join(client.vaultPath, records[0].siblingPath));
        await client.conflictStore.notifySiblingDeleted(
          records[0].siblingPath,
        );
        expect(client.conflictStore.hasPending("shared.md")).toBe(true);
        expect(client.conflictStore.forPath("shared.md")).toHaveLength(1);

        // Sync after first resolve — path still blocked, remote
        // unchanged.
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "shared.md")).toBe(
          "theirs v2\n",
        );

        // Resolve sibling 2 (the remaining one).
        fs.rmSync(path.join(client.vaultPath, records[1].siblingPath));
        await client.conflictStore.notifySiblingDeleted(
          records[1].siblingPath,
        );
        expect(client.conflictStore.hasPending("shared.md")).toBe(false);

        // Now sync pushes ours v2.
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "shared.md")).toBe(
          "ours v2\n",
        );
      },
      300_000,
    );
  },
);
