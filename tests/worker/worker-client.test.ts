// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WorkerClient, {
  computeCpuPoolSize,
} from "../../src/worker/worker-client";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../../src/worker/types";

// Node doesn't have the Web Worker API. These tests simulate it with
// a hand-rolled `FakeWorker` that mirrors the postMessage / message
// event contract closely enough for WorkerClient's purposes — plus
// a `__deliverRequest` hook so a test can choose what reply to send
// for each incoming message. Each FakeWorker has its own message
// handler list, so a pool of them models the orchestra correctly.

class FakeWorker {
  static instances: FakeWorker[] = [];
  static replyMode:
    | "echo"
    | "pong"
    | "error"
    | "noop"
    | "swap-id"
    | "drop" = "pong";

  url: string;
  terminated = false;
  private listeners: Array<(e: MessageEvent) => void> = [];

  constructor(url: string) {
    this.url = url;
    FakeWorker.instances.push(this);
  }

  addEventListener(_type: "message", h: (e: MessageEvent) => void): void {
    this.listeners.push(h);
  }

  removeEventListener(_type: "message", h: (e: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((x) => x !== h);
  }

  postMessage(msg: WorkerRequest): void {
    // Simulate worker behaviour according to the static replyMode.
    // Use queueMicrotask so the reply is asynchronous like a real
    // Worker (the client's dispatch must work even when the reply
    // doesn't arrive synchronously).
    queueMicrotask(() => {
      if (this.terminated) return;
      let reply: WorkerResponse | null = null;
      switch (FakeWorker.replyMode) {
        case "pong":
          reply = { id: msg.id, ok: true, result: "pong" };
          break;
        case "echo":
          reply = {
            id: msg.id,
            ok: true,
            result: (msg as Extract<WorkerRequest, { op: "echo" }>).payload,
          };
          break;
        case "error":
          reply = { id: msg.id, ok: false, error: "fake-error" };
          break;
        case "swap-id":
          reply = { id: "wrong-id", ok: true, result: "stray" };
          break;
        case "drop":
        case "noop":
          // Don't reply at all.
          return;
      }
      if (reply === null) return;
      const event = { data: reply } as MessageEvent;
      for (const l of this.listeners) l(event);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

// URL.createObjectURL stand-in. Node 18+ doesn't expose it as a
// browser-style API on URL, so set up a stub that returns a fake
// URL and supports revoke. The WorkerClient uses these only to feed
// into FakeWorker which doesn't actually parse the URL.
class StubBlob {
  parts: BlobPart[];
  type: string;
  constructor(parts: BlobPart[], opts?: { type?: string }) {
    this.parts = parts;
    this.type = opts?.type ?? "";
  }
}
const createdUrls: string[] = [];
const revokedUrls: string[] = [];
let urlCounter = 0;

function setupGlobals(): void {
  (globalThis as { Blob: typeof Blob }).Blob =
    StubBlob as unknown as typeof Blob;
  (globalThis as { URL: typeof URL }).URL = {
    ...URL,
    createObjectURL: ((_blob: Blob) => {
      const u = `blob:fake/${++urlCounter}`;
      createdUrls.push(u);
      return u;
    }) as typeof URL.createObjectURL,
    revokeObjectURL: ((url: string) => {
      revokedUrls.push(url);
    }) as typeof URL.revokeObjectURL,
  } as typeof URL;
}

function resetGlobals(): void {
  FakeWorker.instances = [];
  FakeWorker.replyMode = "pong";
  createdUrls.length = 0;
  revokedUrls.length = 0;
  urlCounter = 0;
}

const FAKE_CPU = "self.addEventListener('message', () => {});";
const FAKE_NETWORK = "self.addEventListener('message', () => {});";

describe("computeCpuPoolSize", () => {
  it("returns 2 when hardware concurrency is undefined", () => {
    expect(computeCpuPoolSize(undefined)).toBe(2);
  });
  it("returns 2 when hardware concurrency is 1 (single-core phone)", () => {
    expect(computeCpuPoolSize(1)).toBe(2);
  });
  it("returns 2 when hardware concurrency is 3 (subtract one)", () => {
    expect(computeCpuPoolSize(3)).toBe(2);
  });
  it("returns 3 when hardware concurrency is 4", () => {
    expect(computeCpuPoolSize(4)).toBe(3);
  });
  it("caps at 4 even with 16 cores", () => {
    expect(computeCpuPoolSize(16)).toBe(4);
  });
});

describe("WorkerClient — orchestra pool", () => {
  beforeEach(() => {
    setupGlobals();
    resetGlobals();
  });

  afterEach(() => {
    resetGlobals();
  });

  it("constructs CPU pool sized to hardwareConcurrency rule", () => {
    const client = new WorkerClient({
      hardwareConcurrency: 8,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    expect(client.cpuPoolSize).toBe(4);
    // One network worker on top of the pool.
    expect(FakeWorker.instances.length).toBe(5);
    expect(client.isFallback).toBe(false);
    client.terminate();
  });

  it("falls back to main-thread mode when Worker constructor is missing", () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: undefined as unknown as typeof Worker,
    });
    expect(client.isFallback).toBe(true);
    expect(FakeWorker.instances.length).toBe(0);
  });

  it("falls back to main-thread mode when worker source is empty", () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    expect(client.isFallback).toBe(true);
  });

  it("falls back to main-thread when Worker constructor throws", () => {
    class ThrowingWorker {
      constructor() {
        throw new Error("nope");
      }
    }
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: ThrowingWorker as unknown as typeof Worker,
    });
    expect(client.isFallback).toBe(true);
  });

  it("revokes all Blob URLs after terminate()", () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    expect(createdUrls.length).toBe(2); // one cpu + one network blob
    client.terminate();
    expect(revokedUrls.length).toBe(2);
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
  });
});

describe("WorkerClient — dispatch round-trip", () => {
  beforeEach(() => {
    setupGlobals();
    resetGlobals();
  });

  afterEach(() => {
    resetGlobals();
  });

  it("resolves ping with pong from a CPU worker", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const result = await client.dispatch<string>({
      id: client.newRequestId(),
      op: "ping",
    });
    expect(result).toBe("pong");
    client.terminate();
  });

  it("echoes a payload via the echo op", async () => {
    FakeWorker.replyMode = "echo";
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const out = await client.dispatch<{ x: number }>({
      id: client.newRequestId(),
      op: "echo",
      payload: { x: 42 },
    });
    expect(out).toEqual({ x: 42 });
    client.terminate();
  });

  it("rejects when the worker replies with ok: false", async () => {
    FakeWorker.replyMode = "error";
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    await expect(
      client.dispatch({ id: client.newRequestId(), op: "ping" }),
    ).rejects.toThrow("fake-error");
    client.terminate();
  });

  it("multiplexes 10 concurrent pings — every promise resolves", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const pongs = await Promise.all(
      Array.from({ length: 10 }, () =>
        client.dispatch<string>({
          id: client.newRequestId(),
          op: "ping",
        }),
      ),
    );
    expect(pongs).toHaveLength(10);
    expect(new Set(pongs)).toEqual(new Set(["pong"]));
    client.terminate();
  });

  it("ignores replies with unknown request IDs (drops silently)", async () => {
    FakeWorker.replyMode = "swap-id";
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    // Race the dispatch against a short timeout; we expect it to
    // STILL be pending (no resolver hit) because the worker
    // returned a reply with a non-matching id.
    const dispatched = client.dispatch({
      id: client.newRequestId(),
      op: "ping",
    });
    const flagged = Promise.race([
      dispatched.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("still-pending"), 30)),
    ]);
    expect(await flagged).toBe("still-pending");
    client.terminate();
  });

  it("rejects pending promises when terminate() runs mid-flight", async () => {
    FakeWorker.replyMode = "drop";
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const dispatched = client.dispatch({
      id: client.newRequestId(),
      op: "ping",
    });
    client.terminate();
    await expect(dispatched).rejects.toThrow("WorkerClient terminated");
  });

  it("fallback mode handles ping via main-thread handler", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    expect(client.isFallback).toBe(true);
    const out = await client.dispatch<string>({
      id: client.newRequestId(),
      op: "ping",
    });
    expect(out).toBe("pong-main-fallback");
  });

  it("fallback mode echoes payload via main-thread handler", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const out = await client.dispatch<{ s: string }>({
      id: client.newRequestId(),
      op: "echo",
      payload: { s: "hi" },
    });
    expect(out).toEqual({ s: "hi" });
  });
});
