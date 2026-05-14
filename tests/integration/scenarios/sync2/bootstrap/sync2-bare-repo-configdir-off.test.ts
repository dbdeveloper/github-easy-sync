import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  bootstrapEnabled,
  listRemoteFiles,
  recreateRepo,
  requireBootstrapEnv,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// A-cfg-off — bare-repo bootstrap with syncConfigDir = false.
//
// Companion to sync2-bare-repo-configdir-on. Pins the safer default:
// non-invariant configDir content stays local. The two invariant
// gitignores bypass the gate (they carry shared rules every device
// must agree on, including the "Push plugins data.json" toggle line)
// and still land on the remote.
//
// See the on-variant for the mock-vs-production caveat — the gate
// itself is what this test pins; the detector-side enumeration is
// a separate concern.

(bootstrapEnabled() ? describe : describe.skip)(
  "sync2 A-cfg-off — bare-repo bootstrap with syncConfigDir = false",
  () => {
    let client: Sync2TestClient | undefined;
    const branch = "main";

    beforeEach(async () => {
      await recreateRepo(requireBootstrapEnv());
      await new Promise((r) => setTimeout(r, 1500));
    });

    afterEach(() => {
      client?.cleanup();
      client = undefined;
    });

    it(
      "configDir snippet and app.json stay local; only invariant gitignores + user note land",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({
          branch,
          env,
          syncConfigDir: false,
        });

        await client.vault.adapter.write("Welcome.md", "welcome\n");
        await client.vault.adapter.mkdir(".obsidian/snippets");
        await client.vault.adapter.write(
          ".obsidian/snippets/dark.css",
          ".dark { color: white; }\n",
        );
        await client.vault.adapter.write(
          ".obsidian/app.json",
          JSON.stringify({ promptDelete: false }) + "\n",
        );

        await sync2AllAndAssertNoErrors(client);

        const remoteFiles = await listRemoteFiles(branch, env);
        // Invariant gitignores still propagate (bypass clause).
        expect(remoteFiles).toContain(".gitignore");
        expect(remoteFiles).toContain(".obsidian/.gitignore");
        expect(remoteFiles).toContain(
          ".obsidian/plugins/github-gitless-sync/.gitignore",
        );
        // Root-level user note lands.
        expect(remoteFiles).toContain("Welcome.md");
        // OFF: non-invariant configDir content does NOT land.
        expect(remoteFiles).not.toContain(".obsidian/snippets/dark.css");
        expect(remoteFiles).not.toContain(".obsidian/app.json");
      },
      210_000,
    );
  },
);
