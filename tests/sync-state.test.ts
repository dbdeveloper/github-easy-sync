import { describe, it, expect } from "vitest";
import {
  AdoptionAnalysis,
  LocalState,
  RemoteState,
  decideInitAction,
  shouldAutoAdopt,
} from "../src/sync-state";

const remoteBare: RemoteState = { kind: "bare", reason: "fresh repo" };
const remoteHasManifest: RemoteState = {
  kind: "has-manifest",
  treeSha: "tree123",
  files: { "Notes/x.md": { path: "Notes/x.md", sha: "abc", mode: "100644", type: "blob", size: 0, url: "" } },
  manifest: { lastSync: 0, files: {} },
};
const remoteHasContent: RemoteState = {
  kind: "has-content-no-manifest",
  treeSha: "tree456",
  files: { "Notes/y.md": { path: "Notes/y.md", sha: "def", mode: "100644", type: "blob", size: 0, url: "" } },
  sampleFiles: ["Notes/y.md"],
};

const localEmpty: LocalState = { kind: "empty" };
const localHasManifest: LocalState = { kind: "has-manifest", fileCount: 5 };
const localHasContent: LocalState = {
  kind: "has-content-no-manifest",
  fileCount: 3,
  sampleFiles: ["a.md", "b.md", "c.md"],
};

describe("decideInitAction (no resume)", () => {
  it("bare + empty → bootstrap", () => {
    expect(decideInitAction(localEmpty, remoteBare, false).kind).toBe(
      "bootstrap-empty",
    );
  });

  it("bare + has-manifest → first-sync-from-local (push local up)", () => {
    expect(
      decideInitAction(localHasManifest, remoteBare, false).kind,
    ).toBe("first-sync-from-local");
  });

  it("bare + has-content → first-sync-from-local", () => {
    expect(
      decideInitAction(localHasContent, remoteBare, false).kind,
    ).toBe("first-sync-from-local");
  });

  it("has-manifest + empty → first-sync-from-remote", () => {
    expect(
      decideInitAction(localEmpty, remoteHasManifest, false).kind,
    ).toBe("first-sync-from-remote");
  });

  it("has-manifest + has-manifest → regular-sync (init complete)", () => {
    expect(
      decideInitAction(localHasManifest, remoteHasManifest, false).kind,
    ).toBe("regular-sync");
  });

  it("has-manifest + has-content (local) → needs-adoption-analysis", () => {
    expect(
      decideInitAction(localHasContent, remoteHasManifest, false).kind,
    ).toBe("needs-adoption-analysis");
  });

  it("has-content + empty → first-sync-from-remote", () => {
    expect(
      decideInitAction(localEmpty, remoteHasContent, false).kind,
    ).toBe("first-sync-from-remote");
  });

  it("has-content + has-manifest → needs-adoption-analysis", () => {
    expect(
      decideInitAction(localHasManifest, remoteHasContent, false).kind,
    ).toBe("needs-adoption-analysis");
  });

  it("has-content + has-content → needs-adoption-analysis", () => {
    expect(
      decideInitAction(localHasContent, remoteHasContent, false).kind,
    ).toBe("needs-adoption-analysis");
  });
});

describe("decideInitAction (resume)", () => {
  it("resume + bare → bootstrap (recovery)", () => {
    expect(decideInitAction(localEmpty, remoteBare, true).kind).toBe(
      "bootstrap-empty",
    );
  });

  it("resume + has-manifest → first-sync-from-remote", () => {
    expect(
      decideInitAction(localHasContent, remoteHasManifest, true).kind,
    ).toBe("first-sync-from-remote");
  });

  it("resume + has-content overrides ambiguity → first-sync-from-remote", () => {
    // Without resume this would be "needs-adoption-analysis", but a
    // partial download in progress means we should keep pulling, not
    // re-analyze.
    expect(
      decideInitAction(localHasContent, remoteHasContent, true).kind,
    ).toBe("first-sync-from-remote");
  });
});

describe("shouldAutoAdopt", () => {
  const make = (over: Partial<AdoptionAnalysis>): AdoptionAnalysis => ({
    localFileSHAs: {},
    identical: [],
    localOnly: [],
    remoteOnly: [],
    conflicting: [],
    ...over,
  });

  it("auto-adopts on pure 100% match", () => {
    expect(
      shouldAutoAdopt(make({ identical: ["a.md", "b.md", "c.md"] })),
    ).toBe(true);
  });

  it("auto-adopts when local has extras only", () => {
    expect(
      shouldAutoAdopt(
        make({ identical: ["a.md"], localOnly: ["new.md"] }),
      ),
    ).toBe(true);
  });

  it("auto-adopts when remote has extras only", () => {
    expect(
      shouldAutoAdopt(
        make({ identical: ["a.md"], remoteOnly: ["fromRemote.md"] }),
      ),
    ).toBe(true);
  });

  it("auto-adopts when both sides have extras (no conflicts)", () => {
    expect(
      shouldAutoAdopt(
        make({
          identical: ["a.md"],
          localOnly: ["L.md"],
          remoteOnly: ["R.md"],
        }),
      ),
    ).toBe(true);
  });

  it("does NOT auto-adopt with any conflicting files", () => {
    expect(
      shouldAutoAdopt(make({ conflicting: ["bad.md"] })),
    ).toBe(false);
    expect(
      shouldAutoAdopt(
        make({
          identical: ["a.md"],
          conflicting: ["bad.md"],
        }),
      ),
    ).toBe(false);
  });
});
