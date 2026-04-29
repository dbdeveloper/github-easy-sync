import { defineConfig } from "vitest/config";
import path from "path";
import dotenv from "dotenv";

// Performance baselines — not assertions. Each test in tests/perf/
// runs an end-to-end sync against the real GitHub API and records
// timing data via console.log; nothing fails on slow runs (perf is
// signal, not a gate).
//
// Opt-in via `npm run test:perf`. Not invoked by the integration
// suite or its CI workflow because:
//   * Per-run cost — P4 alone uploads 245 files; P2 ships ~13 MB.
//   * Run time — significantly past the integration suite's
//     10-minute budget.
//   * Network noise — a single rate-limit blip skews numbers.
//
// Reuses the integration suite's env handling (fine-grained PAT
// against the private int-test repo). Branch-per-test + cleanup,
// just like the integration suite.

dotenv.config({ path: path.resolve(__dirname, ".env.test") });

export default defineConfig({
  test: {
    include: ["tests/perf/**/*.test.ts"],
    fileParallelism: false,
    // 30-minute ceiling so the largest fixtures (P4) can complete
    // even on a slow link without the timeout firing.
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000,
    alias: {
      obsidian: path.resolve(__dirname, "mock-obsidian.ts"),
      src: path.resolve(__dirname, "src"),
    },
    setupFiles: [path.resolve(__dirname, "tests/integration/setup.ts")],
    // Reuse the integration suite's teardown — drops the ephemeral
    // bootstrap repo if it ended up created during the run. Perf
    // doesn't touch bootstrap, so this is a no-op in practice.
    globalSetup: [path.resolve(__dirname, "tests/integration/teardown.ts")],
    // Each P-test prints baseline JSON; default reporter swallows
    // stdout in non-TTY runs. `verbose` keeps the prints visible.
    reporters: ["verbose"],
  },
});
