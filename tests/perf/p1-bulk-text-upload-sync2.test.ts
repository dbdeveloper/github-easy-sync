import { describe, it, beforeAll, beforeEach, afterEach } from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  uniqueBranchName,
} from "../integration/helpers";
import {
  makeSync2Engine,
  ParametricEngine,
} from "../integration/scenarios/parametric/engine-factory";
import { timed } from "./perf-helpers";

// P1 (sync2) — same shape as the legacy P1: 100/250/500 markdown
// files staged in the vault, then one sync to push them all. The
// timed block measures only the SECOND sync (the bulk push); the
// first sync wraps bootstrap-from-remote on the freshly cloned
// branch and isn't what we want to compare.
//
// Output (one line per case):
//   PERF_BASELINE {"name":"P1-sync2-100","ms":...,"files":100,...}
describe.skipIf(!integrationEnabled())(
  "P1 (sync2) — bulk text upload baselines (100 / 250 / 500 files)",
  () => {
    let engine: ParametricEngine | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p1-sync2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      engine?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it.each([100, 250, 500])(
      "P1 (sync2) with %i files",
      async (count) => {
        engine = makeSync2Engine({ branch });
        // Priming triggers bootstrap-from-remote so the timed block
        // measures pure incremental upload.
        await engine.syncAll();

        let bytesStaged = 0;
        for (let i = 0; i < count; i++) {
          const subfolder = (i % 10).toString().padStart(2, "0");
          const p = `Notes/sub-${subfolder}/note-${String(i).padStart(4, "0")}.md`;
          const c = `# Note ${i}\n\nGenerated for P1 perf baseline.\n` +
            `Body line filler so each file has a non-trivial SHA.\n`;
          bytesStaged += Buffer.byteLength(c, "utf-8");
          await engine.vault.adapter.write(p, c);
        }

        await timed(
          `P1-sync2-${count}`,
          { files: count, bytes: bytesStaged, engine: "sync2" },
          () => (engine as ParametricEngine).syncAll(),
        );
      },
      30 * 60_000,
    );
  },
);
