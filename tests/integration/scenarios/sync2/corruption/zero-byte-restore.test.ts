import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
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
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Corruption resilience — the zero-byte restore guard (SYNC2 §2.9).
//
// A file that collapses to 0 bytes despite a non-empty last-synced
// version is treated as an accidental deletion: the engine restores
// the last good version and never pushes the empty copy. The guard
// must NOT, however, fight a *deliberately* empty file created the
// honest way (delete + commit, then create empty).

describe.skipIf(!integrationEnabled())(
  "sync2 corruption — zero-byte restore guard",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-zero-byte-restore");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it("accidental collapse: 0-byte local + non-empty remote → restored from GitHub, no empty push", async () => {
      const c = await createSync2Client({ branch });
      client = c;
      const good = "valuable note content\n";
      await c.vault.adapter.write("note.md", good);
      await sync2AllAndAssertNoErrors(c);
      // Sanity: remote has the good content.
      expect(await readRemoteFile(branch, "note.md")).toBe(good);

      // Simulate corruption — the file collapses to 0 bytes.
      await c.vault.adapter.write("note.md", "");
      await sync2AllAndAssertNoErrors(c);

      // The guard restored the local file from GitHub …
      expect(fs.readFileSync(path.join(c.vaultPath, "note.md"), "utf8")).toBe(
        good,
      );
      // … and the empty version never reached the server.
      expect(await readRemoteFile(branch, "note.md")).toBe(good);

      // A follow-up sync is a clean no-op (snapshot matches restore).
      await sync2AllAndAssertNoErrors(c);
      expect(await readRemoteFile(branch, "note.md")).toBe(good);
    });

    it("brand-new empty file (no snapshot history) → pushed as a legitimate empty file", async () => {
      const c = await createSync2Client({ branch });
      client = c;
      await c.vault.adapter.write("fresh-empty.md", "");
      await sync2AllAndAssertNoErrors(c);

      // The empty file is on the remote (carve-out: no snapshot → push).
      const remoteFiles = await listRemoteFiles(branch);
      expect(remoteFiles).toContain("fresh-empty.md");
      expect(await readRemoteFile(branch, "fresh-empty.md")).toBe("");
    });

    it("intentional empty via delete+recreate: old content does NOT auto-return", async () => {
      const c = await createSync2Client({ branch });
      client = c;
      const original = "original content the user wants gone\n";
      await c.vault.adapter.write("doc.md", original);
      await sync2AllAndAssertNoErrors(c);
      expect(await readRemoteFile(branch, "doc.md")).toBe(original);

      // Honest path to an empty file: delete + commit first …
      await c.vault.adapter.remove("doc.md");
      await sync2AllAndAssertNoErrors(c);
      // The deletion reached the remote (snapshot row cleared).
      expect(await listRemoteFiles(branch)).not.toContain("doc.md");

      // … then create the empty file.
      await c.vault.adapter.write("doc.md", "");
      await sync2AllAndAssertNoErrors(c);

      // Local stays empty — the guard's "no snapshot" carve-out lets
      // it through; the old content is NOT resurrected.
      expect(fs.readFileSync(path.join(c.vaultPath, "doc.md"), "utf8")).toBe(
        "",
      );
      // Remote has the empty file, not the original content.
      expect(await listRemoteFiles(branch)).toContain("doc.md");
      expect(await readRemoteFile(branch, "doc.md")).toBe("");
    });
  },
);
