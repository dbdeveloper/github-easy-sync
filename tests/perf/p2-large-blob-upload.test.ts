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

// P2 — single 10 MB binary uploaded through createBlob (binaries
// always take that path; text would inline through createTree).
// ~13.4 MB base64 in the request body — well under GitHub's 100 MB
// blob cap.
//
// Catches regressions in createBlob HTTP plumbing or the base64
// encoder. Bytes are deterministic so the SHA stays stable across
// runs (re-runs on the same branch would hit the upload-skip cache).
//
// Output: PERF_BASELINE {"name":"P2-10MB","ms":...,"bytes":10485760}
describe.skipIf(!integrationEnabled())(
  "P2 — single 10 MB blob upload baseline",
  () => {
    let client: Sync2TestClient | undefined;
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
      "10 MB binary uploads in one sync",
      async () => {
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        const bytes = 10 * 1024 * 1024;
        const buf = deterministicBytes("p2-10mb", bytes);
        await client.vault.adapter.writeBinary(
          "Assets/blob-10mb.bin",
          buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength,
          ) as ArrayBuffer,
        );

        await timed("P2-10MB", { bytes }, () =>
          sync2AllAndAssertNoErrors(client as Sync2TestClient),
        );
      },
      30 * 60_000,
    );
  },
);
