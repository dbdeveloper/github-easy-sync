// Stage 8 micro-benchmark: WorkerClient round-trip overhead.
//
// Worker dispatch costs ~5-10 ms per round-trip (postMessage +
// structured clone). The Stage 4 thresholds (BASE64: 2 MB; SHA:
// 100 KB; MERGE: 100 KB) were chosen at "where the worker pays for
// itself"; this bench measures the actual overhead in the test
// environment to validate the thresholds remain reasonable.
//
// Test environment caveat: Node has no native Worker, so the
// WorkerClient takes its main-thread fallback path. What we
// measure here is therefore the fallback dispatch overhead, NOT a
// real Worker round-trip. The numbers are still useful as a "floor"
// for the dispatch costs we add on top of the underlying op; real
// Worker overhead is strictly higher and needs phone validation.

import { describe, it } from "vitest";
import { emit } from "./perf-helpers";
import WorkerClient from "../../src/worker/worker-client";

describe("perf — WorkerClient dispatch overhead (main-thread fallback)", () => {
  it("ping × 100", async () => {
    const client = new WorkerClient();
    const ITER = 100;
    const t0 = Date.now();
    for (let i = 0; i < ITER; i++) {
      await client.dispatch({ id: client.newRequestId(), op: "ping" });
    }
    const ms = Date.now() - t0;
    emit({
      name: "perf-worker-ping-100",
      ms,
      msPerOp: ms / ITER,
      iterations: ITER,
      isFallback: client.isFallback,
    });
    client.terminate();
  });

  it("echo with 1 KB payload × 50", async () => {
    const client = new WorkerClient();
    const ITER = 50;
    const payload = { data: "x".repeat(1024) };
    const t0 = Date.now();
    for (let i = 0; i < ITER; i++) {
      await client.dispatch({
        id: client.newRequestId(),
        op: "echo",
        payload,
      });
    }
    const ms = Date.now() - t0;
    emit({
      name: "perf-worker-echo-1KB-50",
      ms,
      msPerOp: ms / ITER,
      iterations: ITER,
      payloadBytes: 1024,
      isFallback: client.isFallback,
    });
    client.terminate();
  });

  it("decodeBase64 below threshold (small payload, fallback runs inline)", async () => {
    const client = new WorkerClient();
    const ITER = 50;
    const b64 = Buffer.from("x".repeat(10 * 1024)).toString("base64");
    const t0 = Date.now();
    for (let i = 0; i < ITER; i++) {
      await client.decodeBase64(b64);
    }
    const ms = Date.now() - t0;
    emit({
      name: "perf-worker-decode-10KB-50",
      ms,
      msPerOp: ms / ITER,
      iterations: ITER,
      payloadBytes: 10 * 1024,
      isFallback: client.isFallback,
    });
    client.terminate();
  });
});
