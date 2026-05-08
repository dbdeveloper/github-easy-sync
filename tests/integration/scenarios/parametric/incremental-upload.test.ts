import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  readRemoteFile,
  uniqueBranchName,
} from "../../helpers";
import { ENGINES, ParametricEngine } from "./engine-factory";

// One scenario, two engines: add a file locally → sync → file is on
// the remote with the right content. The shape is identical for
// legacy SyncManager and Sync2Manager — anything they don't agree on
// stays out of parametric tests by design.
describe.skipIf(!integrationEnabled())(
  "parametric — incremental upload of one new local file",
  () => {
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("parametric-up");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      await deleteBranchIfExists(branch);
    });

    describe.each(ENGINES)("$name engine", ({ make }) => {
      let engine: ParametricEngine | undefined;

      afterEach(() => {
        engine?.cleanup();
      });

      it(
        "uploads the file and the remote has it on next listing",
        async () => {
          engine = make({ branch });
          // Prime: legacy needs an initial sync to capture state;
          // sync2 needs the same to run bootstrap-from-remote.
          await engine.syncAll();

          await engine.vault.adapter.write("Note.md", "hello world");
          await engine.syncAll();

          const remote = await listRemoteFiles(branch);
          expect(remote).toContain("Note.md");
          expect(await readRemoteFile(branch, "Note.md")).toBe(
            "hello world",
          );
        },
        120_000,
      );
    });
  },
);
