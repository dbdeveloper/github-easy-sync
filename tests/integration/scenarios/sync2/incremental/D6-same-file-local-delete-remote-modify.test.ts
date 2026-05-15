import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  readRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// D6 — same file: local-delete vs remote-modify.
//
// New contract (replaces the legacy "silent delete-wins"): when a path
// in the batch's deletions list also got modified on the remote since
// the last sync, reconcile fires the onConflict callback with ours=""
// (the deletion) vs theirs=remote-modified-bytes. The user picks the
// outcome:
//   - resolved with empty content ⇒ keep the delete (delete wins)
//   - resolved with non-empty content ⇒ restore the file with that
//     content (deletion canceled, restored bytes push to remote)
//   - deferred ⇒ sibling file in vault, deletion dropped from batch,
//     ConflictStore tracks until user clears the sibling
//
// All three branches are exercised below.

describe.skipIf(!integrationEnabled())(
  "sync2 D6 — same file: local delete + remote modify → conflict",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d6-same-del-vs-mod");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "user keeps the delete (resolved empty) → x gone on both sides",
      async () => {
        client = await createSync2Client({
          branch,
          onConflict: async () => ({ kind: "resolved", content: "" }),
        });
        await client.vault.adapter.write("x.md", "x v1\n");
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.remove("x.md");
        await writeRemoteFile(
          branch,
          "x.md",
          "x v2 from other device\n",
          "[other] modify x.md",
        );

        await sync2AllAndAssertNoErrors(client);

        expect(fs.existsSync(path.join(client.vaultPath, "x.md"))).toBe(false);
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain("x.md");
      },
      240_000,
    );

    it(
      "user keeps remote (resolved with theirs content) → x restored locally and remote unchanged",
      async () => {
        client = await createSync2Client({
          branch,
          onConflict: async (args) => ({
            kind: "resolved",
            content: args.theirs,
          }),
        });
        await client.vault.adapter.write("x.md", "x v1\n");
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.remove("x.md");
        await writeRemoteFile(
          branch,
          "x.md",
          "x v2 from other device\n",
          "[other] modify x.md",
        );

        await sync2AllAndAssertNoErrors(client);

        // File restored locally with remote's content.
        expect(
          fs.readFileSync(path.join(client.vaultPath, "x.md"), "utf8"),
        ).toBe("x v2 from other device\n");
        // Remote also has the same content (we either pushed it or
        // left it as-is).
        expect(await readRemoteFile(branch, "x.md")).toBe(
          "x v2 from other device\n",
        );
      },
      240_000,
    );

    it(
      "user picks merged content (resolved non-empty) → x restored + pushed",
      async () => {
        const merged = "x merged: local-deleted + remote-modified\n";
        client = await createSync2Client({
          branch,
          onConflict: async () => ({ kind: "resolved", content: merged }),
        });
        await client.vault.adapter.write("x.md", "x v1\n");
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.remove("x.md");
        await writeRemoteFile(
          branch,
          "x.md",
          "x v2 from other device\n",
          "[other] modify x.md",
        );

        await sync2AllAndAssertNoErrors(client);

        expect(
          fs.readFileSync(path.join(client.vaultPath, "x.md"), "utf8"),
        ).toBe(merged);
        expect(await readRemoteFile(branch, "x.md")).toBe(merged);
      },
      240_000,
    );

    it(
      "user defers → sibling file appears, deletion dropped, remote untouched",
      async () => {
        client = await createSync2Client({
          branch,
          onConflict: async () => ({ kind: "deferred" }),
        });
        await client.vault.adapter.write("x.md", "x v1\n");
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.remove("x.md");
        await writeRemoteFile(
          branch,
          "x.md",
          "x v2 from other device\n",
          "[other] modify x.md",
        );

        await sync2AllAndAssertNoErrors(client);

        // ConflictStore has a pending record for x.md.
        expect(client.conflictStore.hasPending("x.md")).toBe(true);
        const records = client.conflictStore.forPath("x.md");
        expect(records).toHaveLength(1);

        // Sibling file with theirs content sits in the vault.
        const siblingPath = records[0].siblingPath;
        expect(fs.existsSync(path.join(client.vaultPath, siblingPath))).toBe(
          true,
        );
        expect(
          fs.readFileSync(path.join(client.vaultPath, siblingPath), "utf8"),
        ).toBe("x v2 from other device\n");

        // Remote x.md untouched (we didn't push the deletion).
        expect(await readRemoteFile(branch, "x.md")).toBe(
          "x v2 from other device\n",
        );
      },
      240_000,
    );
  },
);
