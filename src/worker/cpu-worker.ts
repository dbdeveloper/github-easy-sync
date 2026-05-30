// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// CPU worker — runs in a separate thread inside Obsidian's WebView
// (Chromium on desktop, Capacitor's WebView on mobile).
//
// Worker scope has `self`, `postMessage`, `addEventListener`, plus
// standard Web APIs (`atob`, `crypto.subtle`, `fetch`, `Uint8Array`,
// `TextEncoder`/`TextDecoder`). No Obsidian APIs are available here
// — the main thread is the only place that can touch `vault.adapter`.
//
// Stage 3 implements only `ping` and `echo` for orchestra wiring
// validation. Stage 4 adds `decode-base64`, `merge-text` (node-diff3),
// and `compute-sha`. Stage 6 leaves all GitHub HTTP ops to the
// network worker — this worker stays pure-CPU.
//
// IMPORTANT: bundled as an IIFE by esbuild (see esbuild.config.mjs).
// The whole file becomes a self-executing string that `WorkerClient`
// turns into a Blob URL at runtime. No ES module syntax at the top
// level after bundling.

import type { WorkerRequest, WorkerResponse } from "./types";

// Worker `self` is `DedicatedWorkerGlobalScope` — but bundling
// against the standard TS dom lib drags in Window types. We type
// the post side narrowly and assert.
const w = self as unknown as {
  addEventListener: (
    type: "message",
    handler: (e: MessageEvent<WorkerRequest>) => void,
  ) => void;
  postMessage: (msg: WorkerResponse) => void;
};

w.addEventListener("message", (e) => {
  const msg = e.data;
  try {
    switch (msg.op) {
      case "ping": {
        w.postMessage({ id: msg.id, ok: true, result: "pong" });
        return;
      }
      case "echo": {
        w.postMessage({ id: msg.id, ok: true, result: msg.payload });
        return;
      }
    }
  } catch (err) {
    w.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
