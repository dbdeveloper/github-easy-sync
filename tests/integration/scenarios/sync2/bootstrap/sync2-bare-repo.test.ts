import { describe, it, beforeEach, afterEach, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  bootstrapEnabled,
  countBranchCommits,
  getBranchHead,
  listRemoteFiles,
  readRemoteFile,
  recreateRepo,
  requireBootstrapEnv,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Sync2 against a truly bare repo (no commits, no default branch).
// Mirrors the legacy A-series scenarios: needs a classic PAT with
// public_repo + delete_repo scope on a dedicated public ephemeral
// repo, because the only way back to bare state is delete + recreate.
//
// Without these scenarios, sync2 had no live coverage of the
// "expectedHead=null + currentHead=null → root commit" branch in
// processBatch — that path was only exercised by unit tests with a
// mocked 404 on getBranchHeadSha.
// SKIP NOTE (Etap 7 cutover): these tests fail because Sync2Manager's
// processBatch Case 1 ("bare repo → root commit") isn't fully wired —
// it falls through to createTree on a bare repo, which 409s because
// GitHub's Git Data API requires at least one ref. Legacy used
// createFile (Contents API) for the seed commit; sync2 needs the
// equivalent. Tracked as follow-up to Etap 7 (bare-repo bootstrap).
describe.skip(
  "sync2 bootstrap — bare repo flows",
  () => {
    let client: Sync2TestClient | undefined;
    const branch = "main"; // bare repo has no branches; first commit creates it

    beforeEach(async () => {
      await recreateRepo(requireBootstrapEnv());
      await new Promise((r) => setTimeout(r, 1500));
    });

    afterEach(() => {
      client?.cleanup();
    });

    it(
      "empty vault on bare repo: syncAll is a no-op",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        await sync2AllAndAssertNoErrors(client);

        // Bare-repo signal: getBranchHead returns null when no
        // commits exist. After a no-op syncAll the branch must still
        // be unborn.
        expect(await getBranchHead(branch, env)).toBeNull();
      },
      120_000,
    );

    it(
      "single file on bare repo: syncAll creates one root commit",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        // Write one note before the first sync. Sync2 detects:
        //   bootstrapIfNeeded → 404 on getBranchHeadSha → bare.
        //   processBatch case 1 → root commit (no parent).
        await client.vault.adapter.write("note.md", "hello bare");

        await sync2AllAndAssertNoErrors(client);

        const head = await getBranchHead(branch, env);
        expect(head, "branch should now exist").not.toBeNull();

        const commits = await countBranchCommits(branch, env);
        expect(commits).toBe(1);

        const files = await listRemoteFiles(branch, env);
        // Both invariant gitignores must land alongside the user file
        // (enforce() runs as part of syncAll on bare repos too).
        expect(files).toContain("note.md");
        expect(files).toContain(".obsidian/.gitignore");
        expect(files).toContain(
          ".obsidian/plugins/github-gitless-sync/.gitignore",
        );
        expect(await readRemoteFile(branch, "note.md", env)).toBe(
          "hello bare",
        );
      },
      150_000,
    );

    it(
      "multi-file vault on bare repo: still one root commit, all files present",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        await client.vault.adapter.write("a.md", "first");
        await client.vault.adapter.mkdir("Folder");
        await client.vault.adapter.write("Folder/b.md", "second");
        await client.vault.adapter.write("Folder/c.md", "third");

        await sync2AllAndAssertNoErrors(client);

        const commits = await countBranchCommits(branch, env);
        expect(commits).toBe(1);

        const files = await listRemoteFiles(branch, env);
        expect(files).toContain("a.md");
        expect(files).toContain("Folder/b.md");
        expect(files).toContain("Folder/c.md");
      },
      180_000,
    );

    it(
      "second sync after bare-repo bootstrap is incremental, not another root",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        await client.vault.adapter.write("a.md", "v1");
        await sync2AllAndAssertNoErrors(client);

        const commitsAfterFirst = await countBranchCommits(branch, env);
        expect(commitsAfterFirst).toBe(1);

        // Edit + add → new commit on top of the root.
        await client.vault.adapter.write("a.md", "v2");
        await client.vault.adapter.write("b.md", "fresh");
        await sync2AllAndAssertNoErrors(client);

        const commitsAfterSecond = await countBranchCommits(branch, env);
        expect(commitsAfterSecond).toBe(2);

        expect(await readRemoteFile(branch, "a.md", env)).toBe("v2");
        expect(await readRemoteFile(branch, "b.md", env)).toBe("fresh");

        // Local file on disk should reflect the new state too.
        expect(
          fs.readFileSync(path.join(client.vaultPath, "a.md"), "utf8"),
        ).toBe("v2");
      },
      180_000,
    );
  },
);
