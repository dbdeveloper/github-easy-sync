import { describe, it, beforeAll, beforeEach, afterEach } from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  uniqueBranchName,
} from "../../helpers";
import { ENGINES, ParametricEngine } from "./engine-factory";

// Benchmark: with a primed vault of N files, how long does a Sync
// click that has no work to do actually take? This is where sync2's
// design choices (early-exit on unchanged HEAD, mtime-cache, no
// double-fetch of tree+manifest) should beat the legacy engine.
//
// Output is a console.log per engine with the wall-clock timing —
// the test never fails on slowness (perf is signal, not a gate).
// Run with `--reporter=verbose` to see it stand out alongside the
// vitest pass marker.
describe.skipIf(!integrationEnabled())(
  "parametric — idle-sync benchmark",
  () => {
    let branch: string;
    const FILE_COUNT = 30;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("bench-idle");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      await deleteBranchIfExists(branch);
    });

    describe.each(ENGINES)("$name engine", ({ name, make }) => {
      let engine: ParametricEngine | undefined;

      afterEach(() => {
        engine?.cleanup();
      });

      it(
        `times an idle sync after priming ${FILE_COUNT} files`,
        async () => {
          engine = make({ branch });

          // Priming: warm up the engine (legacy needs first sync,
          // sync2 needs bootstrap-from-remote).
          await engine.syncAll();

          // Populate the vault with FILE_COUNT plain markdown files.
          for (let i = 0; i < FILE_COUNT; i++) {
            await engine.vault.adapter.write(
              `note-${String(i).padStart(3, "0")}.md`,
              `content ${i}`,
            );
          }
          // Push them all so the second sync has nothing to do.
          await engine.syncAll();

          // The measurement: how long does Sync take when nothing
          // changed locally and HEAD didn't move on remote?
          const t0 = Date.now();
          await engine.syncAll();
          const idleMs = Date.now() - t0;

          // eslint-disable-next-line no-console
          console.log(
            `\n[BENCHMARK ${name}] idle sync over ${FILE_COUNT} primed files: ${idleMs}ms`,
          );
        },
        300_000,
      );
    });
  },
);
