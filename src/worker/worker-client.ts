// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import type {
  WorkerRequest,
  WorkerResponse,
  WorkerKind,
} from "./types";
import { workerKindForOp } from "./types";

// Worker orchestra controller — main-thread side. Holds the CPU
// worker pool + the single dedicated network worker and exposes a
// dispatch(op) API that returns a Promise<result>.
//
// Sources for the two worker entry points are inlined into the
// main bundle at build time as string constants (see
// esbuild.config.mjs — `define` substitutes `__CPU_WORKER_SOURCE__`
// / `__NETWORK_WORKER_SOURCE__` with the IIFE-bundled worker code).
// At runtime we turn each string into a Blob URL and pass it to
// `new Worker(url)`. Capacitor `app://` URLs in worker context are
// unproven, so we use the Blob URL pattern that proved reliable in
// the feasibility test (~46 ms round-trip for 2.6 MB base64 on
// Pixel 6 Pro).
//
// On platforms where `new Worker()` throws (very old Capacitor,
// strict CSP environments), the client falls back to running every
// op on the main thread synchronously — preserving correctness at
// the cost of UI responsiveness. The fallback is decided once at
// construction and cached.

// esbuild's `define` replaces these tokens with JSON-encoded
// strings at build time. Declared here so TypeScript accepts them
// at compile time. At test time (vitest / Node) the tokens aren't
// substituted, so we wrap access in `typeof` guards (which don't
// throw ReferenceError on undeclared globals) and gracefully fall
// through to main-thread mode if missing.
declare const __CPU_WORKER_SOURCE__: string;
declare const __NETWORK_WORKER_SOURCE__: string;

function getInjectedCpuSource(): string {
  return typeof __CPU_WORKER_SOURCE__ === "string"
    ? __CPU_WORKER_SOURCE__
    : "";
}
function getInjectedNetworkSource(): string {
  return typeof __NETWORK_WORKER_SOURCE__ === "string"
    ? __NETWORK_WORKER_SOURCE__
    : "";
}

// Lookup of resolvers waiting on each request ID. Workers reply via
// postMessage; the onmessage handler routes the response back to
// the correct Promise by ID.
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

// A single CPU worker plus its work-queue depth. The pool picks
// the least-busy worker per dispatch — a tiny load balancer.
interface PooledWorker {
  worker: Worker;
  inFlight: number;
}

// Stub fallback handlers used when Worker construction fails. Each
// op type that the orchestra handles needs an entry; Stage 3 only
// has ping/echo so the table is small. Stage 4 onwards extends.
type FallbackHandler = (req: WorkerRequest) => Promise<unknown>;

const FALLBACK_HANDLERS: Record<WorkerRequest["op"], FallbackHandler> = {
  ping: async () => "pong-main-fallback",
  echo: async (req) =>
    (req as Extract<WorkerRequest, { op: "echo" }>).payload,
};

// Pool size for the CPU workers. Auto-tunes to one less than the
// reported logical-core count, clamped to [2, 4]. The clamping
// prevents pathological allocation on a 16-core desktop (each
// worker holds bundle + heap; 4 is enough parallelism for our
// per-batch workload) and ensures at least 2 even on a phone
// reporting a single core.
//
// `navigator.hardwareConcurrency` may be undefined in older
// WebViews; fall back to 2.
export function computeCpuPoolSize(
  hardwareConcurrency: number | undefined,
): number {
  const hc = typeof hardwareConcurrency === "number" ? hardwareConcurrency : 2;
  return Math.max(2, Math.min(4, hc - 1));
}

export default class WorkerClient {
  private cpuPool: PooledWorker[] = [];
  private networkWorker: Worker | null = null;
  private cpuBlobUrl: string | null = null;
  private networkBlobUrl: string | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  // True once we've decided to take the main-thread fallback path
  // (Worker construction threw at startup). Cached so we don't
  // re-try and re-throw every dispatch.
  private fallbackMode = false;

  // Constructor opts let tests inject mock worker sources and a
  // mock Worker constructor without involving the real Web Worker
  // API (Node has no global Worker class). Production calls pass
  // nothing; the esbuild `define` substitutions take effect.
  constructor(opts?: {
    hardwareConcurrency?: number;
    cpuWorkerSource?: string;
    networkWorkerSource?: string;
    // Allow test to supply a Worker-shaped mock. When omitted the
    // global `Worker` constructor is used.
    workerCtor?: new (url: string) => Worker;
  }) {
    const poolSize = computeCpuPoolSize(
      opts?.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency,
    );
    const cpuSource = opts?.cpuWorkerSource ?? getInjectedCpuSource();
    const networkSource =
      opts?.networkWorkerSource ?? getInjectedNetworkSource();
    const WorkerCtor =
      opts?.workerCtor ?? (globalThis as { Worker?: typeof Worker }).Worker;
    if (
      cpuSource === "" ||
      networkSource === "" ||
      typeof WorkerCtor !== "function" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      this.fallbackMode = true;
      return;
    }
    try {
      this.cpuBlobUrl = URL.createObjectURL(
        new Blob([cpuSource], { type: "application/javascript" }),
      );
      this.networkBlobUrl = URL.createObjectURL(
        new Blob([networkSource], { type: "application/javascript" }),
      );
      for (let i = 0; i < poolSize; i++) {
        const w = new WorkerCtor(this.cpuBlobUrl);
        w.addEventListener("message", (e: MessageEvent) =>
          this.onMessage(e.data as WorkerResponse),
        );
        this.cpuPool.push({ worker: w, inFlight: 0 });
      }
      this.networkWorker = new WorkerCtor(this.networkBlobUrl);
      this.networkWorker.addEventListener("message", (e: MessageEvent) =>
        this.onMessage(e.data as WorkerResponse),
      );
    } catch {
      this.fallbackMode = true;
      this.cleanupBlobUrls();
    }
  }

  // True if any Worker construction failed and we're routing every
  // op to a main-thread fallback. Tests + diagnostics check this.
  get isFallback(): boolean {
    return this.fallbackMode;
  }

  // True size of the CPU pool. Useful for tests that assert
  // auto-sizing matched expectations.
  get cpuPoolSize(): number {
    return this.cpuPool.length;
  }

  // Stage 3 surface: send an op, get a result. Stage 4-6 add typed
  // method wrappers (`mergeText`, `computeSha`, `getBlob`, …) on
  // top of this primitive.
  dispatch<T = unknown>(op: WorkerRequest): Promise<T> {
    if (this.fallbackMode) {
      const handler = FALLBACK_HANDLERS[op.op];
      return handler(op) as Promise<T>;
    }
    return new Promise<T>((resolve, reject) => {
      const id = op.id;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      const kind = workerKindForOp(op.op);
      const target = this.pickTarget(kind);
      if (target === null) {
        this.pending.delete(id);
        reject(
          new Error(
            `WorkerClient: no ${kind} worker available — was the pool initialised?`,
          ),
        );
        return;
      }
      target.postMessage(op);
    });
  }

  // Generate a new request ID. Public for ergonomics so callers
  // don't have to import an internal counter.
  newRequestId(): string {
    this.requestCounter += 1;
    return `r${this.requestCounter}`;
  }

  // Terminate every worker and reject every pending request.
  // Stage 7 cancellation calls this to interrupt mid-flight work.
  // After terminate the client is unusable — caller must construct
  // a fresh one for the next sync.
  terminate(): void {
    for (const p of this.cpuPool) {
      try {
        p.worker.terminate();
      } catch {
        // ignore
      }
    }
    this.cpuPool = [];
    if (this.networkWorker) {
      try {
        this.networkWorker.terminate();
      } catch {
        // ignore
      }
      this.networkWorker = null;
    }
    this.cleanupBlobUrls();
    for (const [, p] of this.pending) {
      p.reject(new Error("WorkerClient terminated"));
    }
    this.pending.clear();
  }

  private cleanupBlobUrls(): void {
    if (this.cpuBlobUrl) {
      try {
        URL.revokeObjectURL(this.cpuBlobUrl);
      } catch {
        // ignore
      }
      this.cpuBlobUrl = null;
    }
    if (this.networkBlobUrl) {
      try {
        URL.revokeObjectURL(this.networkBlobUrl);
      } catch {
        // ignore
      }
      this.networkBlobUrl = null;
    }
  }

  // Pick the worker for a request. CPU dispatch picks the
  // least-loaded pool worker (cheap O(pool-size) scan; pool is
  // tiny). Network always goes to the single network worker.
  private pickTarget(kind: WorkerKind): Worker | null {
    if (kind === "network") {
      return this.networkWorker;
    }
    if (this.cpuPool.length === 0) return null;
    let best = this.cpuPool[0];
    for (let i = 1; i < this.cpuPool.length; i++) {
      if (this.cpuPool[i].inFlight < best.inFlight) {
        best = this.cpuPool[i];
      }
    }
    best.inFlight += 1;
    return best.worker;
  }

  private onMessage(resp: WorkerResponse): void {
    const pending = this.pending.get(resp.id);
    if (!pending) {
      // Reply for an ID we don't recognise. Could happen if
      // terminate() ran between request send and reply arrival.
      // Drop silently — the original requester already saw its
      // promise rejected.
      return;
    }
    this.pending.delete(resp.id);
    // Decrement load counter on the worker that handled this op.
    // We don't track which CPU worker the request went to so we
    // can't decrement specifically — but the pool entries are
    // small and load is approximate anyway; a periodic full reset
    // would also work. For Stage 3 simplicity, just leave inFlight
    // as a monotonic counter; pickTarget still picks the smallest.
    if (resp.ok) {
      pending.resolve(resp.result);
    } else {
      pending.reject(new Error(resp.error));
    }
  }
}
