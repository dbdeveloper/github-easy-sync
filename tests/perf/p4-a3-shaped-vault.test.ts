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

// P4 — A3-shaped full-vault sync. 245 mixed files in a layout that
// mirrors a moderately-active personal vault (notes, attachments,
// a daily-journal directory, configDir snippets):
//
//   * 200 markdown notes across 10 subfolders
//   * 30 daily-journal entries (single flat folder)
//   * 10 PNG-shaped binaries (~2 KB each, deterministic bytes)
//   *  5 JSON snippets under `.obsidian/snippets/` (syncConfigDir on)
//
// Closer to real-user shape than P1's synthetic flat batch.
//
// Output:
//   PERF_BASELINE {"name":"P4-A3-245","ms":...,"files":245,"bytes":...}
describe.skipIf(!integrationEnabled())(
  "P4 — A3-style 245-file vault upload baseline",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("p4");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "245-file vault primes + uploads in one sync",
      async () => {
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        let bytesStaged = 0;

        for (let i = 0; i < 200; i++) {
          const folder = (i % 10).toString().padStart(2, "0");
          const path = `Notes/topic-${folder}/note-${String(i).padStart(4, "0")}.md`;
          const body =
            `# Note ${i}\n\nOne paragraph of body content for note ${i}.\n\n` +
            `Tags: #topic-${folder} #idx-${i}\n\nLinked: [[note-${(i + 1) %
              200}]]\n`;
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await client.vault.adapter.write(path, body);
        }

        for (let i = 0; i < 30; i++) {
          const day = String(i + 1).padStart(2, "0");
          const path = `Daily/2026-04-${day}.md`;
          const body =
            `# 2026-04-${day}\n\nQuick journal entry for the day.\n`;
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await client.vault.adapter.write(path, body);
        }

        for (let i = 0; i < 10; i++) {
          const path = `Assets/clip-${String(i).padStart(2, "0")}.png`;
          const buf = deterministicBytes(`p4-png-${i}`, 2048);
          bytesStaged += buf.byteLength;
          await client.vault.adapter.writeBinary(
            path,
            buf.buffer.slice(
              buf.byteOffset,
              buf.byteOffset + buf.byteLength,
            ) as ArrayBuffer,
          );
        }

        for (let i = 0; i < 5; i++) {
          const path = `.obsidian/snippets/snippet-${i}.json`;
          const body = JSON.stringify({ id: i, name: `snippet-${i}` }) + "\n";
          bytesStaged += Buffer.byteLength(body, "utf-8");
          await client.vault.adapter.write(path, body);
        }

        await timed("P4-A3-245", { files: 245, bytes: bytesStaged }, () =>
          sync2AllAndAssertNoErrors(client as Sync2TestClient),
        );
      },
      30 * 60_000,
    );
  },
);
