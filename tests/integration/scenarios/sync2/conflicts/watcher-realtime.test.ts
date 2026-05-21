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

// Pseudo-merge stage 9 — real-time ConflictWatcher.
//
// Drain wraps its batch loop in ConflictWatcher.pause()/resume()
// (so mid-drain sibling writes don't loop back into the classifier).
// OUTSIDE of drain, vault.on(delete | modify | rename) events fire
// the classifier in real time: the user deletes a sibling and the
// ConflictStore record disappears before the next sync click.
//
// This integration test exercises that real-time path end-to-end:
//   1. Trigger a conflict on a file.
//   2. WITHOUT calling sync, delete the sibling AND fire a vault
//      delete event (the mock vault doesn't auto-translate fs ops
//      into events; production Obsidian does, but our adapter is a
//      passthrough to fs).
//   3. Flush the watcher's in-flight chain.
//   4. Assert the ConflictStore record is gone right then.
//   5. Next sync drains the (empty) queue and finalizes the
//      conflict branch.

describe.skipIf(!integrationEnabled())(
  "sync2 pseudo-merge — ConflictWatcher fires classifier in real time (stage 9)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let conflictBranchToCleanup: string | undefined;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-pseudo-watcher");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
      if (conflictBranchToCleanup) {
        await deleteBranchIfExists(conflictBranchToCleanup);
        conflictBranchToCleanup = undefined;
      }
    });

    it(
      "vault.on('delete', sibling) drops record before any further sync",
      async () => {
        await writeRemoteFile(
          branch,
          "note.md",
          "shared baseline\n",
          "[seed] baseline",
        );
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // Trigger conflict.
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          "ours\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "note.md",
          "theirs\n",
          "[web] divergent",
        );
        await sync2AllAndAssertNoErrors(client);

        const records = client.conflictStore.getByPath("note.md");
        expect(records).toHaveLength(1);
        const cb = (
          client.store as unknown as {
            data: { conflictBranch: { name: string; head: string } | null };
          }
        ).data.conflictBranch;
        expect(cb).not.toBeNull();
        conflictBranchToCleanup = cb!.name;

        // User deletes the sibling. The mock vault.adapter doesn't
        // synthesize Obsidian events on fs ops; we explicitly fire
        // delete to drive the watcher (production Obsidian fires
        // this for real on user-initiated deletes).
        const siblingPath = records[0].siblingPath;
        fs.rmSync(path.join(client.vaultPath, siblingPath));
        (
          client.vault as unknown as {
            fireEvent: (event: string, ...args: unknown[]) => number;
          }
        ).fireEvent("delete", { path: siblingPath });

        // Watcher runs evaluateConflictState async via its internal
        // chain. Flush before asserting.
        await client.conflictWatcher.flush();

        // Record gone BEFORE we call sync.
        expect(client.conflictStore.hasPending("note.md")).toBe(false);

        // Next sync drains the empty queue and finalizes the
        // conflict branch (drain-end sweep is a no-op since
        // there's nothing left; finalize fires because cb !== null
        // and records.length === 0).
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "note.md")).toBe("ours\n");
        const cbAfter = (
          client.store as unknown as {
            data: { conflictBranch: { name: string; head: string } | null };
          }
        ).data.conflictBranch;
        expect(cbAfter).toBeNull();
        conflictBranchToCleanup = undefined;
      },
      360_000,
    );

    it(
      "drain pauses watcher: mid-drain sibling write doesn't loop classifier",
      async () => {
        // Setup: trigger a conflict so a sibling exists. The drain
        // that registered the conflict already paused/resumed
        // around the partition + finalize cycle. We just verify
        // post-drain state stays sane and a second sync with no
        // changes is a clean no-op.
        await writeRemoteFile(
          branch,
          "note.md",
          "shared\n",
          "[seed]",
        );
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          "ours\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "note.md",
          "theirs\n",
          "[web]",
        );
        await sync2AllAndAssertNoErrors(client);

        const records = client.conflictStore.getByPath("note.md");
        expect(records).toHaveLength(1);
        const cb = (
          client.store as unknown as {
            data: { conflictBranch: { name: string; head: string } | null };
          }
        ).data.conflictBranch;
        conflictBranchToCleanup = cb!.name;

        // Watcher should NOT be paused after drain completes.
        expect(client.conflictWatcher.isPaused()).toBe(false);

        // A second sync against the same state should be a clean
        // no-op for the conflict layer: record stays, branch stays,
        // no finalize.
        await sync2AllAndAssertNoErrors(client);
        expect(client.conflictStore.hasPending("note.md")).toBe(true);
        expect(
          (
            client.store as unknown as {
              data: {
                conflictBranch: { name: string; head: string } | null;
              };
            }
          ).data.conflictBranch,
        ).not.toBeNull();
      },
      360_000,
    );
  },
);
