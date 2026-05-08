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

// P2 (sync2) — single 10 MB binary upload. Same fixture as legacy P2;
// the timing is an apples-to-apples comparison of how each engine's
// push pipeline handles a single large blob.
//
// Output: PERF_BASELINE {"name":"P2-sync2-10MB","ms":...,"bytes":10485760}
describe.skipIf(!integrationEnabled())(
  "P2 (sync2) — single 10 MB blob upload baseline",
  () => {
    let engine: ParametricEngine | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p2-sync2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      engine?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "10 MB binary lands in one sync (sync2)",
      async () => {
        const target = "Assets/p2-blob.bin";
        const TEN_MB = 10 * 1024 * 1024;
        const buf = deterministicBytes("p2-seed", TEN_MB);

        engine = makeSync2Engine({ branch });
        await engine.syncAll(); // priming + bootstrap

        await engine.vault.adapter.writeBinary(
          target,
          buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength,
          ) as ArrayBuffer,
        );

        await timed(
          "P2-sync2-10MB",
          { bytes: TEN_MB, engine: "sync2" },
          () => (engine as ParametricEngine).syncAll(),
        );
      },
      30 * 60_000,
    );
  },
);
