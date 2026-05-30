// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Wire-format types shared between the main-thread `WorkerClient`
// and the two worker entry points (`cpu-worker.ts`, `network-worker.ts`).
//
// Discriminated unions on `op` give us exhaustive type checking on
// both sides; `id` is a per-request UUID that the client uses to
// route the reply back to the right pending Promise. The same envelope
// works for both CPU and network workers — dispatch happens client-side.
//
// Stage 3 ships only `ping` and `echo` ops. Stages 4-6 add the real
// work (decode-base64, merge-text, compute-sha, github-* calls).

export type WorkerRequest =
  | { id: string; op: "ping" }
  | { id: string; op: "echo"; payload: unknown };

export type WorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

// Which worker should handle a given op. Stage 3 hardcodes ping/echo
// to CPU (network worker also handles ping for its own sanity check).
// Stages 4-6 will extend this mapping; downstream Stage 6 moves all
// `github-*` ops to network.
export type WorkerKind = "cpu" | "network";

export function workerKindForOp(op: WorkerRequest["op"]): WorkerKind {
  switch (op) {
    case "ping":
    case "echo":
      return "cpu";
  }
}
