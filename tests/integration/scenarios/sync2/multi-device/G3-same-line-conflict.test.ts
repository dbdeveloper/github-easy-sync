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
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// G3 — two devices edit the SAME line of the same file. 3-way merge
// cannot resolve, so the device that syncs second hits onConflict.
// Tests the conflict path composes properly across real multi-device
// round-trips (not just remote-write + local-edit faked via Contents
// API like the conflicts-misc/* suite uses).

describe.skipIf(!integrationEnabled())(
  "sync2 G3 — same-line conflict across two devices, resolved",
  () => {
    let deviceA: Sync2TestClient | undefined;
    let deviceB: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-g3-same-line");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      deviceA?.cleanup();
      deviceB?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "both devices edit line 1 → onConflict on the second pusher; resolved → both sides converge",
      async () => {
        // Shared baseline pushed by A.
        deviceA = await createSync2Client({ branch });
        await deviceA.vault.adapter.write(
          "note.md",
          "shared line\nline 2\n",
        );
        await sync2AllAndAssertNoErrors(deviceA);

        // B pulls baseline. onConflict picks ours (B's) wholesale —
        // simplest deterministic resolver. The point of this test is
        // that the path is *reached* end-to-end through two real
        // sync2 devices, not the merge content itself.
        let conflictFired = 0;
        deviceB = await createSync2Client({
          branch,
          onConflict: async (a) => {
            conflictFired += 1;
            return { kind: "resolved", content: a.ours };
          },
        });
        await sync2AllAndAssertNoErrors(deviceB);
        expect(
          fs.readFileSync(path.join(deviceB.vaultPath, "note.md"), "utf8"),
        ).toBe("shared line\nline 2\n");

        // Both edit line 1 — different content.
        await deviceA.vault.adapter.write(
          "note.md",
          "line by A\nline 2\n",
        );
        await sync2AllAndAssertNoErrors(deviceA);

        await deviceB.vault.adapter.write(
          "note.md",
          "line by B\nline 2\n",
        );
        // B's syncAll now sees A's commit on remote and hits the
        // conflict path; onConflict above resolves.
        await sync2AllAndAssertNoErrors(deviceB);

        const merged = "line by B\nline 2\n";
        expect(conflictFired).toBeGreaterThan(0);

        // Local on B carries the resolved content.
        expect(
          fs.readFileSync(path.join(deviceB.vaultPath, "note.md"), "utf8"),
        ).toBe(merged);
        // Remote also got the resolved content via B's follow-up push.
        expect(await readRemoteFile(branch, "note.md")).toBe(merged);

        // A pulls and converges too.
        await sync2AllAndAssertNoErrors(deviceA);
        expect(
          fs.readFileSync(path.join(deviceA.vaultPath, "note.md"), "utf8"),
        ).toBe(merged);
      },
      360_000,
    );
  },
);
