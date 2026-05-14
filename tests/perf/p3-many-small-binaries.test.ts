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
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../integration/scenarios/sync2/helpers";
import { deterministicBytes, timed } from "./perf-helpers";

// P3 — 50 small (~1 KB) deterministic binaries uploaded in one
// sync. Stresses the createBlob parallelism in TreeBuilder. All 50
// createBlob calls fire concurrently (Promise.allSettled); if some
// future change serializes the loop, the wall-clock cost would
// roughly multiply by 50 and this baseline would scream.
//
// Each binary is ~1 KB of deterministic noise — small enough that
// network bandwidth isn't the bottleneck (we're measuring per-
// request overhead and parallelism), large enough to be a distinct
// blob (no SHA collisions across the 50).
//
// Output:
//   PERF_BASELINE {"name":"P3-50bin","ms":...,"files":50,"bytesEach":1024}
describe.skipIf(!integrationEnabled())(
  "P3 — 50 small binaries upload baseline (parallelism stress)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p3");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "50 × 1 KB binaries upload in one sync",
      async () => {
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        const count = 50;
        const bytesEach = 1024;
        for (let i = 0; i < count; i++) {
          const path = `Assets/clip-${String(i).padStart(2, "0")}.bin`;
          const buf = deterministicBytes(`p3-bin-${i}`, bytesEach);
          await client.vault.adapter.writeBinary(
            path,
            buf.buffer.slice(
              buf.byteOffset,
              buf.byteOffset + buf.byteLength,
            ) as ArrayBuffer,
          );
        }

        await timed("P3-50bin", { files: count, bytesEach }, () =>
          sync2AllAndAssertNoErrors(client as Sync2TestClient),
        );
      },
      30 * 60_000,
    );
  },
);
