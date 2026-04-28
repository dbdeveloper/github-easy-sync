import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  createClient,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  listVaultFiles,
  readRemoteFile,
  readVaultFile,
  syncAndAssertNoErrors,
  TestClient,
  uniqueBranchName,
  writeVaultFile,
} from "../../helpers";

// F-series — special characters in filenames + content edge cases.
// Each test exercises one specific corner of the sync pipeline:
// path encoding (URL + GitHub Contents API), unusual byte content
// (BOM, line endings, empty), case-only renames. We pair every
// upload with a fresh-client download to verify byte-exact
// round-trip survival; that catches any silent normalization (e.g.
// stripping BOM, converting CRLF→LF) that would corrupt user data.

describe.skipIf(!integrationEnabled())("F-series — special chars + content edge cases", () => {
  let client1: TestClient | undefined;
  let client2: TestClient | undefined;
  let branch: string;

  beforeAll(async () => {
    await ensureRepoNotBare();
  });

  beforeEach(async () => {
    branch = uniqueBranchName("f");
    const head = await getDefaultBranchHead();
    if (!head) throw new Error("default branch missing");
    await createBranchFromHead(branch, head);
  });

  afterEach(async () => {
    client1?.cleanup();
    client2?.cleanup();
    await deleteBranchIfExists(branch);
  });

  // ---- F1 ----------------------------------------------------------
  it(
    "F1 — Cyrillic / emoji / spaces / special chars in file + folder names",
    async () => {
      const files: { [path: string]: string } = {
        "Notes/Українські/Замітка з пробілами.md":
          "# Українські замітки\n\nЦе тест кодування шляху.\n",
        "Notes/💡 ідея/quick (note).md":
          "Emoji у папці + спецсимволи () у файлі.\n",
        "Notes/with ! ? & marks.md": "punctuation: ! ? & — survives.\n",
      };
      client1 = createClient({ branch, deviceName: "f1-push" });
      for (const [p, c] of Object.entries(files)) {
        await writeVaultFile(client1.vault, p, c);
      }
      await client1.sync.loadMetadata();
      await syncAndAssertNoErrors(client1);

      const remote = await listRemoteFiles(branch);
      for (const p of Object.keys(files)) {
        expect(remote, `remote should contain ${p}`).toContain(p);
      }
      // Round-trip through a second client to confirm byte-exact
      // download path also handles the special chars.
      client2 = createClient({ branch, deviceName: "f1-pull" });
      await client2.sync.loadMetadata();
      await syncAndAssertNoErrors(client2);
      for (const [p, c] of Object.entries(files)) {
        expect(await readVaultFile(client2.vault, p)).toBe(c);
      }
    },
    180_000,
  );

  // ---- F2 ----------------------------------------------------------
  it(
    "F2 — long path (close to traditional 260-char limit)",
    async () => {
      // Build a path with a single file deep inside long-named
      // folders. Stays under the 4 KB GitHub URL cap but well past
      // the Windows MAX_PATH limit so we'd notice if the plugin
      // ever assumes a short path.
      const deepFolder = `Notes/${"long-folder-name-segment/".repeat(8)}`; // 8 × 25 = 200 chars
      const longBaseName = `${"x".repeat(60)}.md`; // ~60 chars file name
      const longPath = `${deepFolder}${longBaseName}`;
      expect(longPath.length).toBeGreaterThan(255);

      const content = "Long-path survival check.\n";
      client1 = createClient({ branch, deviceName: "f2-push" });
      await writeVaultFile(client1.vault, longPath, content);
      await client1.sync.loadMetadata();
      await syncAndAssertNoErrors(client1);

      expect(await listRemoteFiles(branch)).toContain(longPath);

      client2 = createClient({ branch, deviceName: "f2-pull" });
      await client2.sync.loadMetadata();
      await syncAndAssertNoErrors(client2);
      expect(await readVaultFile(client2.vault, longPath)).toBe(content);
    },
    180_000,
  );

  // ---- F3 ----------------------------------------------------------
  it(
    "F3 — empty file (0 bytes) round-trips intact",
    async () => {
      const emptyPath = "Notes/empty.md";
      client1 = createClient({ branch, deviceName: "f3-push" });
      await writeVaultFile(client1.vault, emptyPath, "");
      await client1.sync.loadMetadata();
      await syncAndAssertNoErrors(client1);

      expect(await listRemoteFiles(branch)).toContain(emptyPath);
      const remoteContent = await readRemoteFile(branch, emptyPath);
      expect(remoteContent).toBe("");

      client2 = createClient({ branch, deviceName: "f3-pull" });
      await client2.sync.loadMetadata();
      await syncAndAssertNoErrors(client2);
      const localBuf = await client2.vault.adapter.readBinary(emptyPath);
      expect(localBuf.byteLength).toBe(0);
    },
    180_000,
  );

  // ---- F4 ----------------------------------------------------------
  it(
    "F4 — trailing newline preserved (and absence preserved too)",
    async () => {
      const withNewline = "Notes/with-trailing-nl.md";
      const withoutNewline = "Notes/no-trailing-nl.md";
      const withContent = "line one\nline two\n"; // ends with \n
      const withoutContent = "line one\nline two"; // no trailing
      client1 = createClient({ branch, deviceName: "f4-push" });
      await writeVaultFile(client1.vault, withNewline, withContent);
      await writeVaultFile(client1.vault, withoutNewline, withoutContent);
      await client1.sync.loadMetadata();
      await syncAndAssertNoErrors(client1);

      // Byte-level comparison via the API blob blob ensures git
      // didn't normalize / append on its own.
      expect(await readRemoteFile(branch, withNewline)).toBe(withContent);
      expect(await readRemoteFile(branch, withoutNewline)).toBe(withoutContent);

      client2 = createClient({ branch, deviceName: "f4-pull" });
      await client2.sync.loadMetadata();
      await syncAndAssertNoErrors(client2);
      expect(await readVaultFile(client2.vault, withNewline)).toBe(withContent);
      expect(await readVaultFile(client2.vault, withoutNewline)).toBe(withoutContent);
    },
    180_000,
  );

  // ---- F5 ----------------------------------------------------------
  it(
    "F5 — mixed line endings (LF + CRLF) survive without normalization",
    async () => {
      const mixedPath = "Notes/mixed-line-endings.md";
      // Deliberately interleave LF and CRLF.
      const mixed = "line LF\nline CRLF\r\nline LF again\nline CRLF again\r\n";
      client1 = createClient({ branch, deviceName: "f5-push" });
      // Use writeBinary so no encoder ever touches the bytes.
      const bytes = Buffer.from(mixed, "utf-8");
      await client1.vault.adapter.writeBinary(
        mixedPath,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
      await client1.sync.loadMetadata();
      await syncAndAssertNoErrors(client1);

      expect(await readRemoteFile(branch, mixedPath)).toBe(mixed);

      client2 = createClient({ branch, deviceName: "f5-pull" });
      await client2.sync.loadMetadata();
      await syncAndAssertNoErrors(client2);
      const downloadedBytes = await client2.vault.adapter.readBinary(mixedPath);
      expect(Buffer.from(downloadedBytes).toString("utf-8")).toBe(mixed);
    },
    180_000,
  );

  // ---- F6 ----------------------------------------------------------
  it(
    "F6 — UTF-8 BOM at start of file is preserved",
    async () => {
      const bomPath = "Notes/with-bom.md";
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const tail = Buffer.from("# header after BOM\n\nbody.\n", "utf-8");
      const fullBytes = Buffer.concat([bom, tail]);

      client1 = createClient({ branch, deviceName: "f6-push" });
      await client1.vault.adapter.writeBinary(
        bomPath,
        fullBytes.buffer.slice(
          fullBytes.byteOffset,
          fullBytes.byteOffset + fullBytes.byteLength,
        ) as ArrayBuffer,
      );
      await client1.sync.loadMetadata();
      await syncAndAssertNoErrors(client1);

      // Compare raw bytes via blob to confirm no BOM strip server-side.
      const remoteText = await readRemoteFile(branch, bomPath);
      expect(remoteText.charCodeAt(0)).toBe(0xfeff); // BOM as a code point
      expect(Buffer.byteLength(remoteText, "utf-8")).toBe(fullBytes.length);

      client2 = createClient({ branch, deviceName: "f6-pull" });
      await client2.sync.loadMetadata();
      await syncAndAssertNoErrors(client2);
      const downloadedBytes = await client2.vault.adapter.readBinary(bomPath);
      expect(Buffer.from(downloadedBytes).equals(fullBytes)).toBe(true);
    },
    180_000,
  );

  // ---- F7 ----------------------------------------------------------
  it(
    "F7 — case-only rename (delete-then-create) propagates correctly",
    async () => {
      // Direct case-only rename isn't possible on case-insensitive
      // filesystems (default macOS APFS, default Windows NTFS), and
      // Obsidian's rename API mirrors that — users do a 3-step:
      // Note.md → temp.md → note.md, OR delete + create. We model
      // the delete-then-create approach because it's what the
      // events listener would see across both fs types and what
      // any vault on a case-insensitive disk has to do anyway.
      //
      // Linux CI runs on case-sensitive ext4 so we could in theory
      // have both names live at once locally — but the test deletes
      // first to keep the scenario portable. Asserting on remote
      // matters more: GitHub repos are case-sensitive, so the old
      // capitalization should be gone after sync.
      const upper = "Notes/Capitalized.md";
      const lower = "Notes/capitalized.md";
      const content = "case-only rename body — same content, different casing.\n";

      client1 = createClient({ branch, deviceName: "f7-rename" });
      await writeVaultFile(client1.vault, upper, content);
      await client1.sync.loadMetadata();
      await syncAndAssertNoErrors(client1);
      expect(await listRemoteFiles(branch)).toContain(upper);

      // The "rename" — delete uppercase, write lowercase. Re-run
      // loadMetadata so reconcile flags the delete and registers the
      // new file (events listener mock can't see fs.unlink calls).
      await client1.vault.adapter.remove(upper);
      await writeVaultFile(client1.vault, lower, content);
      await client1.sync.loadMetadata();
      await syncAndAssertNoErrors(client1);

      const remoteAfter = await listRemoteFiles(branch);
      expect(
        remoteAfter,
        `remote should drop the original capitalization. Tree: ${JSON.stringify(remoteAfter)}`,
      ).not.toContain(upper);
      expect(
        remoteAfter,
        `remote should hold the new lowercase name`,
      ).toContain(lower);
      expect(await readRemoteFile(branch, lower)).toBe(content);

      // Cross-check: a fresh client downloading from this branch
      // ends up with only the lowercase version. We assert via the
      // disk listing rather than vault.adapter.exists() because on
      // case-insensitive filesystems (default macOS APFS, default
      // Windows NTFS) exists("Capitalized.md") returns true for a
      // file actually stored as "capitalized.md" — that lie would
      // give a false negative here. The listing returns the real
      // stored casing, which is what we care about.
      client2 = createClient({ branch, deviceName: "f7-pull" });
      await client2.sync.loadMetadata();
      await syncAndAssertNoErrors(client2);
      const downloadedFiles = await listVaultFiles(client2.vault);
      expect(downloadedFiles, "client2 should have lowercase").toContain(lower);
      expect(
        downloadedFiles,
        "client2 listing should not include uppercase",
      ).not.toContain(upper);
    },
    180_000,
  );
});
