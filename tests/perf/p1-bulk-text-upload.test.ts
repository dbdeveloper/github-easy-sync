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
import { timed } from "./perf-helpers";

// P1 — bulk text upload at 100 / 250 / 500 files. Times the SECOND
// sync (the one that actually uploads the bulk), not the priming
// first sync. Text content ships inline through createTree, so we
// expect per-sync cost to scale with payload size, not file count
// modulo body limits.
//
// Output (one line per case):
//   PERF_BASELINE {"name":"P1-100","ms":...,"files":100,"bytes":...}
//   PERF_BASELINE {"name":"P1-250","ms":...,"files":250,"bytes":...}
//   PERF_BASELINE {"name":"P1-500","ms":...,"files":500,"bytes":...}
describe.skipIf(!integrationEnabled())(
  "P1 — bulk text upload baselines (100 / 250 / 500 files)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p1");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it.each([100, 250, 500])(
      "P1 with %i files",
      async (count) => {
        client = await createSync2Client({ branch });
        // Priming sync so the timed block measures pure incremental
        // upload, not the first-sync handshake.
        await sync2AllAndAssertNoErrors(client);

        let bytesStaged = 0;
        for (let i = 0; i < count; i++) {
          const subfolder = (i % 10).toString().padStart(2, "0");
          const p = `Notes/sub-${subfolder}/note-${String(i).padStart(4, "0")}.md`;
          const body =
            `# Note ${i}\n\nGenerated for P1 perf baseline.\n` +
            `Body line filler so each file has a non-trivial SHA.\n`;
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await client.vault.adapter.write(p, body);
        }

        await timed(
          `P1-${count}`,
          { files: count, bytes: bytesStaged },
          () => sync2AllAndAssertNoErrors(client as Sync2TestClient),
        );
      },
      30 * 60_000,
    );
  },
);
