import { describe, it, expect } from "vitest";
import {
  isRetriableError,
  isRetriableStatus,
  isWriteRetriableStatus,
  retryUntil,
} from "../src/utils";

// Connection-level retry classifier (src/utils.ts → isRetriableError).
// Drives the throw-side branch of retryUntil so flaky socket errors
// from real GitHub round-trips recover under the same exponential
// backoff used for retriable HTTP status codes.

describe("isRetriableError", () => {
  describe("undici socket / timeout codes", () => {
    it.each([
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET_TIMEOUT",
    ])("returns true for code=%s", (code) => {
      const err = Object.assign(new Error("undici failure"), { code });
      expect(isRetriableError(err)).toBe(true);
    });
  });

  describe("Node net / DNS codes", () => {
    it.each([
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "ETIMEDOUT",
      "EPIPE",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ])("returns true for code=%s", (code) => {
      const err = Object.assign(new Error("net error"), { code });
      expect(isRetriableError(err)).toBe(true);
    });
  });

  describe("Electron / Chromium net codes (Obsidian Desktop)", () => {
    it.each([
      "ERR_NETWORK_CHANGED",
      "ERR_INTERNET_DISCONNECTED",
      "ERR_CONNECTION_RESET",
      "ERR_CONNECTION_CLOSED",
      "ERR_CONNECTION_ABORTED",
      "ERR_CONNECTION_REFUSED",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_NETWORK_ACCESS_DENIED",
      "ERR_TIMED_OUT",
    ])("returns true for code=%s", (code) => {
      const err = Object.assign(new Error("electron net error"), { code });
      expect(isRetriableError(err)).toBe(true);
    });
  });

  describe("message-only heuristic (no code attached)", () => {
    it("returns true for 'other side closed'", () => {
      expect(isRetriableError(new Error("other side closed"))).toBe(true);
    });
    it("returns true for 'socket hang up'", () => {
      expect(isRetriableError(new Error("socket hang up"))).toBe(true);
    });
    it("returns true for 'Failed to fetch' (mobile WebView)", () => {
      expect(isRetriableError(new Error("Failed to fetch"))).toBe(true);
    });
    it("returns true for case-insensitive 'fetch failed' (undici outer wrap)", () => {
      expect(isRetriableError(new Error("fetch failed"))).toBe(true);
      expect(isRetriableError(new Error("Fetch Failed"))).toBe(true);
    });
    it("returns true for 'network error' (Capacitor)", () => {
      expect(isRetriableError(new Error("Network error"))).toBe(true);
    });
  });

  describe("cause-chain walk", () => {
    it("finds the retriable code one level deep", () => {
      const inner = Object.assign(new Error("inner"), {
        code: "UND_ERR_SOCKET",
      });
      const outer = Object.assign(new TypeError("fetch failed"), {
        cause: inner,
      });
      expect(isRetriableError(outer)).toBe(true);
    });
    it("finds the retriable code three levels deep", () => {
      const lvl3 = Object.assign(new Error("deepest"), { code: "ECONNRESET" });
      const lvl2 = Object.assign(new Error("middle"), { cause: lvl3 });
      const lvl1 = Object.assign(new Error("outer"), { cause: lvl2 });
      const lvl0 = Object.assign(new Error("root"), { cause: lvl1 });
      expect(isRetriableError(lvl0)).toBe(true);
    });
    it("stops at depth 5 — depth-7 retriable code is NOT classified", () => {
      // Build a chain where the retriable code lives only at depth 7
      // (root → 6 wraps → SocketError). Walk caps at 5, so we miss it.
      let cur: object = Object.assign(new Error("buried"), {
        code: "UND_ERR_SOCKET",
      });
      for (let i = 0; i < 6; i++) {
        cur = Object.assign(new Error(`wrap ${i}`), { cause: cur });
      }
      expect(isRetriableError(cur)).toBe(false);
    });
    it("returns false when no level has a retriable code or matching message", () => {
      const inner = Object.assign(new Error("oops"), { code: "INTERNAL" });
      const outer = Object.assign(new Error("wrap"), { cause: inner });
      expect(isRetriableError(outer)).toBe(false);
    });
  });

  describe("non-network errors", () => {
    it("returns false for plain Error", () => {
      expect(isRetriableError(new Error("oops"))).toBe(false);
    });
    it("returns false for TypeError without socket cause", () => {
      expect(isRetriableError(new TypeError("bad arg"))).toBe(false);
    });
    it("returns false for null / undefined / primitives", () => {
      expect(isRetriableError(null)).toBe(false);
      expect(isRetriableError(undefined)).toBe(false);
      expect(isRetriableError("string")).toBe(false);
      expect(isRetriableError(404)).toBe(false);
    });
    it("returns false for objects without code or message", () => {
      expect(isRetriableError({})).toBe(false);
    });
    it("returns false for generic 'error' substring (not a known phrase)", () => {
      expect(isRetriableError(new Error("server error 500"))).toBe(false);
      expect(isRetriableError(new Error("some other error"))).toBe(false);
    });
  });
});

describe("retryUntil — throw-side retry on connection errors", () => {
  it("retries on a thrown UND_ERR_SOCKET and succeeds on the second attempt", async () => {
    let calls = 0;
    const result = await retryUntil(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("fetch failed"), {
            cause: Object.assign(new Error("other side closed"), {
              code: "UND_ERR_SOCKET",
            }),
          });
        }
        return { status: 200 };
      },
      (res) => res.status === 200,
      3,
      1, // 1ms initial delay so the test stays fast
      1, // no exponential growth
    );
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
  });

  it("rethrows a non-retriable error without consuming retry budget", async () => {
    let calls = 0;
    await expect(
      retryUntil(
        async () => {
          calls += 1;
          throw new Error("not a network error");
        },
        () => true,
        3,
        1,
        1,
      ),
    ).rejects.toThrow("not a network error");
    expect(calls).toBe(1);
  });

  it("rethrows a retriable error after exhausting maxRetries", async () => {
    let calls = 0;
    await expect(
      retryUntil(
        async () => {
          calls += 1;
          throw Object.assign(new Error("oh no"), { code: "ECONNRESET" });
        },
        () => true,
        2,
        1,
        1,
      ),
    ).rejects.toThrow("oh no");
    expect(calls).toBe(3); // first attempt + 2 retries
  });

  it("status-code retry path still works (sanity)", async () => {
    let calls = 0;
    const result = await retryUntil(
      async () => {
        calls += 1;
        return { status: calls < 3 ? 500 : 200 };
      },
      (res) => !isRetriableStatus(res.status),
      5,
      1,
      1,
    );
    expect(calls).toBe(3);
    expect(result.status).toBe(200);
  });

  it("maxRetries=0: a single thrown retriable error rethrows immediately", async () => {
    let calls = 0;
    await expect(
      retryUntil(
        async () => {
          calls += 1;
          throw Object.assign(new Error("nope"), { code: "UND_ERR_SOCKET" });
        },
        () => true,
        0,
        1,
        1,
      ),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
});

// Sanity — the status predicates exported alongside should keep
// behaving as documented, no regressions from the throw-side patch.
describe("status retry predicates (regression sanity)", () => {
  it("isRetriableStatus: 5xx, 429, 422 → true; 4xx (non-429/422) → false", () => {
    expect(isRetriableStatus(500)).toBe(true);
    expect(isRetriableStatus(502)).toBe(true);
    expect(isRetriableStatus(429)).toBe(true);
    expect(isRetriableStatus(422)).toBe(true);
    expect(isRetriableStatus(404)).toBe(false);
    expect(isRetriableStatus(401)).toBe(false);
    expect(isRetriableStatus(200)).toBe(false);
  });

  it("isWriteRetriableStatus adds 409 on top of isRetriableStatus", () => {
    expect(isWriteRetriableStatus(409)).toBe(true);
    expect(isWriteRetriableStatus(500)).toBe(true);
    expect(isWriteRetriableStatus(404)).toBe(false);
  });
});
