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
import { deterministicBytes, timed } from "./perf-helpers";

// P3 (sync2) — 50 small binaries, one sync. Stresses sync2's
// TreeBuilder.buildTreeEntries Promise.all over createBlob (one call
// per binary, fired in parallel). If somebody serialised that loop
// later, the baseline would jump roughly 50× and the regression
// would be obvious.
//
// Output: PERF_BASELINE {"name":"P3-sync2-50bin","ms":...,"files":50}
describe.skipIf(!integrationEnabled())(
  "P3 (sync2) — 50 binaries upload baseline (parallelism stress)",
  () => {
    let engine: ParametricEngine | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p3-sync2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      engine?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "50 binaries upload in one sync (sync2)",
      async () => {
        const COUNT = 50;
        const BYTES_EACH = 1024;

        engine = makeSync2Engine({ branch });
        await engine.syncAll(); // priming + bootstrap

        for (let i = 0; i < COUNT; i++) {
          const path = `Assets/p3-${String(i).padStart(3, "0")}.bin`;
          const buf = deterministicBytes(`p3-seed-${i}`, BYTES_EACH);
          await engine.vault.adapter.writeBinary(
            path,
            buf.buffer.slice(
              buf.byteOffset,
              buf.byteOffset + buf.byteLength,
            ) as ArrayBuffer,
          );
        }

        await timed(
          "P3-sync2-50bin",
          {
            files: COUNT,
            bytesEach: BYTES_EACH,
            totalBytes: COUNT * BYTES_EACH,
            engine: "sync2",
          },
          () => (engine as ParametricEngine).syncAll(),
        );
      },
      30 * 60_000,
    );
  },
);
