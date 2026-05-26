import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../../sync2/helpers";

// n01 — R3.5 layer 1a (confirmDeleted) end-to-end.
//
// Sequence:
//   1. Local file synced to GitHub.
//   2. Simulate user-driven UI delete: TrashStore.intercept(path)
//      captures bytes → adapter.remove(path) removes from vault.
//   3. Sync — findChanges sees a delete, batch enqueued, push includes
//      the path in deleted-paths.txt. processBatch's success path
//      fires trashHooks.confirmDeleted(["path"]) → matching trash
//      entry wiped.
//
// Verifies the end-to-end: capture → push-confirm → cleanup. Without
// the layer 1a wiring (PR-5b processBatch hook), the trash entry
// would persist until layer 2's drain-end sweep — but here we want
// layer 1a to claim it during the push-success path.

describe.skipIf(!integrationEnabled())(
  "sync2 diff2 n01 — base-delete confirms via layer 1a",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("diff2-n01");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "delete file → trash entry → sync push-confirm → trash empty",
      async () => {
        client = await createSync2Client({ branch });
        const vaultPath = client.vaultPath;
        const filePath = "Notes/idea.md";
        const absFile = path.join(vaultPath, filePath);

        await client.vault.adapter.write(filePath, "# idea\nbody\n");
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).toContain(filePath);

        // Simulate user UI-delete via the same flow trash-watcher would
        // drive in production (monkey-patched vault.delete → intercept,
        // then the original delete). The integration fixture doesn't
        // install trash-watcher; we invoke the pieces in sequence.
        await client.trashStore.intercept(filePath);
        await client.vault.adapter.remove(filePath);
        const beforeSync = await client.trashStore.list();
        expect(beforeSync.map((r) => r.originalPath)).toEqual([filePath]);

        // Sync — push includes the deletion. processBatch success →
        // confirmDeleted([filePath]) → layer 1a wipes the trash entry.
        await sync2AllAndAssertNoErrors(client);

        const afterSync = await client.trashStore.list();
        expect(afterSync).toEqual([]);
        expect(await listRemoteFiles(branch)).not.toContain(filePath);
      },
      210_000,
    );
  },
);
