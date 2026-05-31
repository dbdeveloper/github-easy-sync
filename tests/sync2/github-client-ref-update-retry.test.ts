// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Field bug 2026-05-31: a 422 "Update is not a fast forward" on
// PATCH /git/refs was treated as transient (isWriteRetriableStatus),
// so updateBranchHead retried it ~6× over ~33s of backoff and read
// as a hang. The fix routes ref updates through
// isRefUpdateRetriableStatus, which fails fast on 422 so the next
// drain reconciles instead. These tests pin: ONE PATCH on 422 (no
// retry), but still-retried on genuinely-transient 503.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import GithubClient from "../../src/github/client";
import Logger from "../../src/logger";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import {
  Vault,
  installRequestFaultInjector,
  type FakeResponse,
} from "../../mock-obsidian";

function makeClient(): { client: GithubClient; cleanup: () => void } {
  const root = path.join(
    os.tmpdir(),
    `ref-update-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  const vault = new Vault(root);
  const settings = {
    ...DEFAULT_SETTINGS,
    githubToken: "test-token",
    githubOwner: "test-owner",
    githubRepo: "test-repo",
    githubBranch: "main",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = new Logger(vault as any, "github-easy-sync", false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = new GithubClient(settings, logger as any);
  return { client, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Counts PATCH calls against the branch-head ref and replies with the
// given status. callIndex from the injector is global; we count our
// own matches so the assertion is exact.
function patchCounter(status: number): {
  inject: () => void;
  count: () => number;
} {
  let n = 0;
  const body =
    status === 422
      ? JSON.stringify({
          message: "Update is not a fast forward",
          status: "422",
        })
      : JSON.stringify({ message: "Server error", status: String(status) });
  return {
    inject: () =>
      installRequestFaultInjector({
        intercept(url: string, method: string): FakeResponse | null {
          if (
            method === "PATCH" &&
            url.includes("/git/refs/heads/")
          ) {
            n += 1;
            return { status, body };
          }
          return null;
        },
      }),
    count: () => n,
  };
}

describe("GithubClient.updateBranchHead — ref-update retry policy", () => {
  let cleanup: () => void;
  afterEach(() => {
    installRequestFaultInjector(null);
    if (cleanup) cleanup();
  });

  it("422 (not a fast forward) → exactly ONE PATCH, then throws (no retry storm)", async () => {
    const f = makeClient();
    cleanup = f.cleanup;
    const c = patchCounter(422);
    c.inject();

    await expect(
      // retry: true would have retried the OLD behaviour ~6×.
      f.client.updateBranchHead({ sha: "deadbeef", retry: true, maxRetries: 5 }),
    ).rejects.toThrow(/422/);

    // The whole point of the fix: a single attempt, no backoff loop.
    expect(c.count()).toBe(1);
  });

  it("503 (transient) → STILL retried (regression guard: only 422 changed)", async () => {
    const f = makeClient();
    cleanup = f.cleanup;
    const c = patchCounter(503);
    c.inject();

    // maxRetries: 1 keeps the real exponential backoff (1s) within the
    // test timeout while still proving 503 retries at all — exactly
    // the behaviour 422 must NOT have. (The fact that a higher
    // maxRetries blows past a 5s timeout is itself a re-statement of
    // the field hang the 422 fix removes.)
    await expect(
      f.client.updateBranchHead({ sha: "deadbeef", retry: true, maxRetries: 1 }),
    ).rejects.toThrow(/503/);

    // 1 initial + 1 retry = 2 attempts. Transient statuses are
    // unaffected by the ref-update predicate change.
    expect(c.count()).toBe(2);
  });

  it("422 with retry disabled → ONE PATCH (unchanged for the no-retry path)", async () => {
    const f = makeClient();
    cleanup = f.cleanup;
    const c = patchCounter(422);
    c.inject();

    await expect(
      f.client.updateBranchHead({ sha: "deadbeef" }),
    ).rejects.toThrow(/422/);

    expect(c.count()).toBe(1);
  });
});
