// Unit tests for the typed-error hierarchy from src/errors.ts
// (PUSH-REORGANIZATION §3.4). The tests lock in the contract that
// catch sites rely on:
//   - `instanceof` works for both the specific subclass and the
//     parent classes (so `err instanceof GithubAPIError` catches
//     all five HTTP subclasses, `err instanceof SyncError` catches
//     everything in the hierarchy).
//   - `retriable` is class-driven, not message-driven.
//   - `name` reflects the actual class name (so logs read
//     "StaleStateError: ..." not "Error: ...").
//   - `makeGithubAPIError(status, ...)` dispatches to the right
//     subclass for every mapped status code and falls back to the
//     base class for unmapped codes.

import { describe, it, expect } from "vitest";
import {
  SyncError,
  NetworkError,
  GithubAPIError,
  NotFoundError,
  ConflictError,
  ValidationError,
  AuthError,
  RateLimitError,
  PlatformError,
  StaleStateError,
  makeGithubAPIError,
} from "../src/errors";

describe("errors — class hierarchy", () => {
  it("every subclass extends SyncError (parent-class catches work)", () => {
    const cases = [
      new NetworkError("net"),
      new GithubAPIError("api", 500),
      new NotFoundError("404"),
      new ConflictError("409"),
      new ValidationError("422"),
      new AuthError("403", 403),
      new RateLimitError("429"),
      new PlatformError("platform"),
      new StaleStateError("stale"),
    ];
    for (const err of cases) {
      expect(err).toBeInstanceOf(SyncError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("every GithubAPIError subclass extends GithubAPIError too", () => {
    const apiCases = [
      new NotFoundError("404"),
      new ConflictError("409"),
      new ValidationError("422"),
      new AuthError("403", 403),
      new RateLimitError("429"),
    ];
    for (const err of apiCases) {
      expect(err).toBeInstanceOf(GithubAPIError);
      expect(err).toBeInstanceOf(SyncError);
    }
  });

  it("`name` matches the class name so logs read intuitively", () => {
    // `describeError` (in src/utils.ts) records `name` and `ctor`;
    // the user-facing surface (Notice / activity log / bug reports)
    // reads better when the name reflects the actual class rather
    // than the generic "Error" string.
    expect(new NetworkError("x").name).toBe("NetworkError");
    expect(new NotFoundError("x").name).toBe("NotFoundError");
    expect(new ConflictError("x").name).toBe("ConflictError");
    expect(new ValidationError("x").name).toBe("ValidationError");
    expect(new AuthError("x", 401).name).toBe("AuthError");
    expect(new RateLimitError("x").name).toBe("RateLimitError");
    expect(new PlatformError("x").name).toBe("PlatformError");
    expect(new StaleStateError("x").name).toBe("StaleStateError");
  });

  it("GithubAPIError subclasses carry the correct status code", () => {
    expect(new NotFoundError("x").status).toBe(404);
    expect(new ConflictError("x").status).toBe(409);
    expect(new ValidationError("x").status).toBe(422);
    expect(new AuthError("x", 401).status).toBe(401);
    expect(new AuthError("x", 403).status).toBe(403);
    expect(new RateLimitError("x").status).toBe(429);
    // The base class accepts an arbitrary status (used for unmapped
    // 5xx etc.); it just stores it verbatim.
    expect(new GithubAPIError("x", 502).status).toBe(502);
  });

  it("`retriable` flag is class-driven (NetworkError + RateLimitError = true; others = false)", () => {
    // Catch sites + retryUntil consult `error.retriable` rather
    // than re-deriving from the status code at every call site.
    expect(new NetworkError("x").retriable).toBe(true);
    expect(new RateLimitError("x").retriable).toBe(true);

    expect(new GithubAPIError("x", 500).retriable).toBe(false);
    expect(new NotFoundError("x").retriable).toBe(false);
    expect(new ConflictError("x").retriable).toBe(false);
    expect(new ValidationError("x").retriable).toBe(false);
    expect(new AuthError("x", 403).retriable).toBe(false);
    expect(new PlatformError("x").retriable).toBe(false);
    expect(new StaleStateError("x").retriable).toBe(false);
  });

  it("`body` is preserved when passed (for §7.4 message-body inspection)", () => {
    // PUSH-REORG §7.4 decided that all 422 → ValidationError, with
    // sub-causes distinguished by `body.message`. The catch sites
    // need to read body off the error directly.
    const body = {
      message: "GitRPC::BadObjectState",
      documentation_url: "https://docs.github.com/...",
    };
    const err = new ValidationError("Failed to create tree", body);
    expect(err.body).toEqual(body);
    expect((err.body as { message?: string })?.message).toBe(
      "GitRPC::BadObjectState",
    );
  });

  it("`cause` chains the underlying error for diagnostic transparency", () => {
    const underlying = new TypeError("invalid input");
    const wrapped = new StaleStateError("two observations disagree", {
      cause: underlying,
    });
    expect(wrapped.cause).toBe(underlying);
  });
});

describe("errors — makeGithubAPIError dispatch", () => {
  it("404 → NotFoundError", () => {
    const err = makeGithubAPIError(404, "msg");
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it("409 → ConflictError", () => {
    const err = makeGithubAPIError(409, "msg");
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
  });

  it("422 → ValidationError (per §7.4: BadObjectState is a sub-case identified by body.message)", () => {
    const err = makeGithubAPIError(422, "msg", {
      message: "GitRPC::BadObjectState",
    });
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(422);
    expect((err.body as { message?: string })?.message).toBe(
      "GitRPC::BadObjectState",
    );
  });

  it("401 → AuthError", () => {
    const err = makeGithubAPIError(401, "unauth");
    expect(err).toBeInstanceOf(AuthError);
    expect(err.status).toBe(401);
  });

  it("403 → AuthError", () => {
    const err = makeGithubAPIError(403, "forbidden");
    expect(err).toBeInstanceOf(AuthError);
    expect(err.status).toBe(403);
  });

  it("429 → RateLimitError (retriable=true)", () => {
    const err = makeGithubAPIError(429, "rate-limited");
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect(err.retriable).toBe(true);
  });

  it("unmapped status (e.g. 500) → base GithubAPIError", () => {
    const err = makeGithubAPIError(500, "server error");
    expect(err).toBeInstanceOf(GithubAPIError);
    // Specifically NOT a subclass — the catch-all branch.
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(ValidationError);
    expect(err.status).toBe(500);
  });

  it("preserves message and body across the dispatch", () => {
    const body = { detail: "ref already exists" };
    const err = makeGithubAPIError(409, "Failed to create ref", body);
    expect(err.message).toBe("Failed to create ref");
    expect(err.body).toEqual(body);
  });
});
