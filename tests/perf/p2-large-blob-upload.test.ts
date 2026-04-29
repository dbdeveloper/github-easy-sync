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

// P2 — single large binary upload. 10 MB of non-compressible bytes
// shipped through createBlob (binaries take that path; text would
// inline into createTree instead). Useful for comparing across
// runs whether the createBlob HTTP path or its base64 encoding
// step regresses.
//
// 10 MB raw → ~13.4 MB base64 in the request body. GitHub's blob
// size cap is 100 MB, so we're well under. Bytes are deterministic
// (same SHA across runs) so a re-run hitting the resume-skip
// optimization won't actually re-upload — perf reflects the
// "fresh" path on the FIRST run after a clean branch only.
//
// Output: PERF_BASELINE {"name":"P2-10MB","ms":...,"bytes":10485760}
describe.skipIf(!integrationEnabled())(
  "P2 — single 10 MB blob upload baseline",
  () => {
    let client: TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p2");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "10 MB binary lands in one sync; record the wall-clock cost",
      async () => {
        const target = "Assets/p2-blob.bin";
        const TEN_MB = 10 * 1024 * 1024;
        const buf = deterministicBytes("p2-seed", TEN_MB);

        client = createClient({ branch, deviceName: "p2-test" });
        await client.sync.loadMetadata();
        await syncAndAssertNoErrors(client);

        // Stage the binary. .bin avoids the text-extension path;
        // sync-manager.ts:1885 routes anything without a text
        // extension through createBlob.
        await client.vault.adapter.writeBinary(
          target,
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        );
        await client.sync.loadMetadata();

        await timed(
          "P2-10MB",
          { bytes: TEN_MB },
          () => syncAndAssertNoErrors(client as TestClient),
        );
      },
      30 * 60_000,
    );
  },
);
