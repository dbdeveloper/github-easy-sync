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
  ENGINES,
  ParametricEngine,
} from "../integration/scenarios/parametric/engine-factory";
import { timed } from "./perf-helpers";

// P5 — idle-sync baseline. Vault has 30 primed files; nothing
// changed locally, nothing changed on remote. The user clicks Sync
// anyway. This is the case sync2 was rebuilt to make cheap, and the
// number that should land in the README under "what improved": on
// a primed vault legacy reads + hashes every file, fetches tree +
// manifest, and decides "nothing to do"; sync2 short-circuits on a
// single getBranchHeadSha and a per-file mtime watermark, never
// touching disk for unchanged files.
//
// Paired across both engines via the ENGINES describe.each so
// `pnpm test:perf` emits PERF_BASELINE lines side by side.
//
// Output (one line per engine):
//   PERF_BASELINE {"name":"P5-legacy-idle-30","ms":...,"engine":"legacy",...}
//   PERF_BASELINE {"name":"P5-sync2-idle-30","ms":...,"engine":"sync2",...}
describe.skipIf(!integrationEnabled())(
  "P5 — idle sync baseline (30 primed files, nothing to do)",
  () => {
    const FILE_COUNT = 30;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p5-idle");
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
        `idle sync over ${FILE_COUNT} primed files`,
        async () => {
          engine = make({ branch });
          await engine.syncAll(); // priming / bootstrap

          for (let i = 0; i < FILE_COUNT; i++) {
            await engine.vault.adapter.write(
              `note-${String(i).padStart(3, "0")}.md`,
              `content ${i}`,
            );
          }
          await engine.syncAll(); // push the bulk

          await timed(
            `P5-${name}-idle-${FILE_COUNT}`,
            { engine: name, files: FILE_COUNT },
            () => (engine as ParametricEngine).syncAll(),
          );
        },
        15 * 60_000,
      );
    });
  },
);
