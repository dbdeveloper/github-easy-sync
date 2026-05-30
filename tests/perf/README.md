# Perf tests

Two flavours of perf tests live here:

1. **End-to-end** (`p1-` through `p5-`): full sync round-trips
   against the real GitHub API. Used to track the
   `Sync2Manager.syncAll()` wall-clock across realistic vault
   shapes (bulk text upload, large blob, many small binaries,
   A3-shaped vault, classifier sweep). Each takes minutes; the
   whole suite takes ~30 min and uses the integration env.

2. **CPU micro-benchmarks** (`perf-cpu-*`, `perf-worker-*`,
   Stage 8): measure the engine's individual CPU operations
   (diff3, base64 decode, SHA computation, WorkerClient dispatch)
   in isolation, no GitHub. Run in seconds; useful for tuning the
   Stage 4 Worker thresholds and the Stage 2/7 size guard.

Both run via `pnpm test:perf` (uses `vitest.perf.config.ts`).
Output is grep-able via the `PERF_BASELINE {…}` sentinel line —
one JSON record per benched op.

## Stage 8 baselines — Node desktop

Measured on the maintainer's M-series Mac, Node 24, 2026-05-30.
These numbers are NOT a regression gate; they're a relative
reference. Real phone numbers vary by 2–5× depending on hardware
and Capacitor WebView version. The absolute size-guard +
threshold values still need on-device validation.

### `node-diff3` 3-way merge

The cliff that motivated `RECONCILE_AUTO_MERGE_LIMIT`. Numbers
mark where wall-clock becomes user-perceptible.

| Input size | Node wall-clock | Notes |
|-----------:|----------------:|-------|
|     100 KB |          ~20 ms | Imperceptible. |
|     500 KB |         ~250 ms | Brief flash. |
|       1 MB |         ~1.0 s  | Notice-able. |
|       2 MB |         ~4.0 s  | Sluggish. |
|       3 MB |         ~8.5 s  | Unacceptable for UI thread. |
|       4 MB |        ~16 s    | Cliff. |
|       5 MB |        ~26 s    | Off-the-shelf. |

Stage 2 size guard (`RECONCILE_AUTO_MERGE_LIMIT = 1_000_000`)
was chosen at the 1 MB notice-able mark. With Stage 4 Worker
offload the UI no longer freezes, but the wall-clock at 5 MB on
mobile (extrapolated ~50–100 s from these Node numbers) is still
beyond what a user will wait for. **Recommend keeping
`RECONCILE_AUTO_MERGE_LIMIT` ≤ 2 MB until on-device measurements
confirm a higher value is acceptable.**

### Base64 decode (`atob` + Uint8Array copy)

The decode path the engine actually runs.

| Input size | Node wall-clock | Notes |
|-----------:|----------------:|-------|
|     100 KB |           ~3 ms | Imperceptible. |
|     500 KB |           ~6 ms | Imperceptible. |
|       1 MB |          ~10 ms | Imperceptible. |
|       2 MB |          ~23 ms | Edge of one frame. |
|       4 MB |          ~40 ms | Noticeable on slow devices. |
|       6 MB |          ~62 ms | Multi-frame stall. |
|      10 MB |          ~80 ms | OK if off main thread. |

Stage 4 BASE64 threshold (2 MB → Worker) sits right at the
"edge of one frame" line on Node. On mobile the same 2 MB will
take 100+ ms — well past one frame — so dispatching to the
Worker pays off. Threshold is reasonable.

### `calculateGitBlobSHA` (`crypto.subtle.digest("SHA-1", …)`)

| Input size | Node wall-clock |
|-----------:|----------------:|
|      10 KB |           ~4 ms |
|      50 KB |           ~1 ms |
|     100 KB |           ~1 ms |
|     500 KB |           ~2 ms |
|       1 MB |           ~3 ms |
|       2 MB |           ~9 ms |
|       4 MB |          ~14 ms |

SHA is cheap end-to-end. Stage 4 SHA threshold (100 KB) sits at
the floor where dispatch overhead matters most. On a phone the
4 MB SHA will likely run 50–100 ms inline; the Worker round-trip
overhead (5–10 ms postMessage + 2× structured clone) starts to
win above ~100 KB. Threshold is well-placed.

### Worker dispatch overhead

In the test environment Node has no native `Worker`, so the
WorkerClient takes its main-thread fallback path. The fallback
dispatch is essentially zero-overhead (handler invocation only):

| Operation | Iterations | Total | Per-op |
|-----------|-----------:|------:|-------:|
| `ping`    | 100        |  ~0 ms |   ~0 ms |
| `echo` (1 KB) | 50     |  ~0 ms |   ~0 ms |
| `decode-base64` (10 KB) | 50 | 6 ms | 0.12 ms |

These numbers are a FLOOR for real Worker dispatch. The Stage 3
CORS feasibility test on a Pixel 6 Pro showed a real Worker
round-trip of ~46 ms for 2.6 MB base64 — that's the
postMessage + structured clone + actual decode + reply. The
**dispatch-only overhead is in the ~5–10 ms range**, consistent
with §5.4's threshold justification.

## How to run

```bash
# All perf tests (end-to-end + CPU micro-benchmarks):
pnpm test:perf

# CPU micro-benchmarks only (~20 seconds, no GitHub):
pnpm vitest run --config vitest.perf.config.ts tests/perf/perf-cpu-* tests/perf/perf-worker-*

# Specific file:
pnpm vitest run --config vitest.perf.config.ts tests/perf/perf-cpu-diff3-timing.test.ts
```

## How to interpret runs

Grep `PERF_BASELINE` from the output:

```bash
pnpm test:perf 2>&1 | grep PERF_BASELINE > baseline-$(date +%Y%m%d).log
```

Two runs can be diffed by comparing the `ms` field per `name`.
A regression script (TODO) will eventually compute the median of
N runs and flag deltas above ±20%.

## Phone validation — TODO

These Node numbers are a relative reference. For the size guard
+ threshold tuning to land in the engine with confidence, the
same matrix needs to run on:

- Obsidian Mobile on Android (Capacitor WebView): the original
  bug environment.
- Obsidian Desktop on macOS / Linux: where most users sit.

The plan is a TEMPORARY Settings-tab button that runs the
micro-benchmarks on the device and writes results to the plugin
log. Same opt-in pattern as the Stage 6 CORS feasibility button
(commit `b4feea9` / reverted `cb1da7d`); strip before final ship.
