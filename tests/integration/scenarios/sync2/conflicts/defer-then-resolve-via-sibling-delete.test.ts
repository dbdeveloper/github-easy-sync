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
  readRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Stage 6.5 — defer + resolve via sibling-delete, end to end against
// real GitHub. The user picks "Later" on a conflict modal: a sibling
// file lands in the vault, the path is excluded from push, and on
// the NEXT sync nothing about it changes on remote. Then the user
// deletes the sibling — that's the "ours wins" signal — and the
// next sync pushes ours to GitHub, replacing theirs.

describe.skipIf(!integrationEnabled())(
  "sync2 conflict — defer then resolve via sibling delete",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-conflict-defer");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "Later → sibling created → delete sibling → next sync pushes ours",
      async () => {
        // Set up a shared baseline both sides start from.
        await writeRemoteFile(
          branch,
          "note.md",
          "shared baseline\n",
          "[seed] baseline",
        );
        client = await createSync2Client({
          // Programmatic onConflict — picks "Later" (deferred).
          onConflict: async () => ({ kind: "deferred" }),
          branch,
        });
        await sync2AllAndAssertNoErrors(client);
        // Local now has the shared baseline.
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "note.md"),
            "utf8",
          ),
        ).toBe("shared baseline\n");

        // Diverge: ours edits line 1 locally, theirs edits the same
        // line on remote. Overlap → 3-way merge fails → onConflict.
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          "ours version\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "note.md",
          "theirs version\n",
          "[web] divergent edit",
        );

        await sync2AllAndAssertNoErrors(client);

        // After deferral: a sibling file appears in the vault (one
        // record only — first conflict on this path).
        const records = client.conflictStore.forPath("note.md");
        expect(records).toHaveLength(1);
        const siblingPath = records[0].siblingPath;
        const siblingAbs = path.join(client.vaultPath, siblingPath);
        expect(fs.existsSync(siblingAbs)).toBe(true);
        expect(fs.readFileSync(siblingAbs, "utf8")).toBe(
          "theirs version\n",
        );

        // Local file unchanged (ours stays).
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "note.md"),
            "utf8",
          ),
        ).toBe("ours version\n");

        // Remote unchanged too (theirs stays — push skipped this path).
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "theirs version\n",
        );

        // Sibling is in the vault but excluded from sync.
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain(siblingPath);

        // User deletes the sibling — close-conflict signal. The
        // listener that wires this in main.ts isn't running here,
        // so call notifySiblingDeleted directly. Then re-sync.
        fs.rmSync(siblingAbs);
        await client.conflictStore.notifySiblingDeleted(siblingPath);
        expect(client.conflictStore.hasPending("note.md")).toBe(false);

        await sync2AllAndAssertNoErrors(client);

        // Remote now has ours.
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "ours version\n",
        );
      },
      300_000,
    );
  },
);
