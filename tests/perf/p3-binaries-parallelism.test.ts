import { describe, it, beforeAll, beforeEach, afterEach } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
} from "../integration/helpers";
import { deterministicBytes, timed } from "./perf-helpers";

// P3 — 50 small binaries (mock images), uploaded in one sync.
// Stresses the createBlob parallelism in commitSync's
// `filesToUpload.map(...)` Promise.all loop (sync-manager.ts
// :1880-1939). All 50 createBlob calls fire concurrently; if
// somebody serialized that loop later, the wall-clock cost would
// roughly multiply by 50 and the perf log would scream.
//
// Each binary is ~1 KB of deterministic noise — small enough that
// network bandwidth isn't the bottleneck (we're measuring the
// per-request overhead and the parallelism), large enough to be
// a distinct blob (no SHA collisions across the 50).
//
// Output: PERF_BASELINE {"name":"P3-50bin","ms":...,"files":50,"bytesEach":1024}
describe.skipIf(!integrationEnabled())(
  "P3 — 50 binaries upload baseline (parallelism stress)",
  () => {
    let client: TestClient | undefined;
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
      "50 binaries upload in one sync; record total + per-file averages",
      async () => {
        const COUNT = 50;
        const BYTES_EACH = 1024;

        client = createClient({ branch, deviceName: "p3-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        for (let i = 0; i < COUNT; i++) {
          const path = `Assets/p3-${String(i).padStart(3, "0")}.bin`;
          const buf = deterministicBytes(`p3-seed-${i}`, BYTES_EACH);
          await client.vault.adapter.writeBinary(
            path,
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
          );
        }
        await client.sync.loadMetadata();

        await timed(
          "P3-50bin",
          { files: COUNT, bytesEach: BYTES_EACH, totalBytes: COUNT * BYTES_EACH },
          () => syncAndAssertNoErrors(client as TestClient),
        );
      },
      30 * 60_000,
    );
  },
);
