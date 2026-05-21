import { defineConfig } from "vitest/config";
import path from "path";
import dotenv from "dotenv";

// Load test credentials before vitest starts so describe/it filters
// that read env vars at module-load time see them.
dotenv.config({ path: path.resolve(__dirname, ".env.test") });

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // Real GitHub round-trips are slow and rate-limited; one-at-a-time
    // also keeps a single shared test repo from being trampled.
    fileParallelism: false,
    // GitHub eventual consistency + per-blob uploads can take a while
    // on large fixtures; give each test 2 minutes.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Same Obsidian alias as the unit suite — mock-obsidian.ts is
    // backed by the real fs, so SyncManager + GitignoreCache + Logger
    // work end-to-end against an isolated tempdir per test. The `src`
    // alias mirrors tsconfig.json's baseUrl: src files use bare
    // `src/...` imports (esbuild handles them in production), so
    // vitest needs the same resolution at test time.
    alias: {
      obsidian: path.resolve(__dirname, "mock-obsidian.ts"),
      src: path.resolve(__dirname, "src"),
    },
    // Skip the whole suite if the integration env isn't set up. The
    // helpers also assert this, but failing early at config-load gives
    // a clearer "no tests ran" message vs a thrown error mid-suite.
    setupFiles: [path.resolve(__dirname, "tests/integration/setup.ts")],
    // Once everything finishes (incl. failures), wipe the ephemeral
    // bootstrap repo so the public-repo + classic-PAT exposure window
    // is bounded by the test run itself.
    globalSetup: [path.resolve(__dirname, "tests/integration/teardown.ts")],
    // Safety net for socket-level transients (undici SocketError /
    // Electron net errors / Capacitor "Failed to fetch") that survive
    // the GithubClient's in-flight retryUntil. Tier-1 fix lives in
    // src/utils.ts (`isRetriableError` + throw-side retry on
    // exponential backoff). This vitest retry sits on top — when a
    // GitHub regional outage exceeds the 5-attempt backoff
    // (1s+2s+4s+8s+16s ≈ 31s), the failed test gets one fresh attempt
    // before we call it a hard failure. Doubles worst-case wall-clock
    // on a flake, costs nothing on a clean run.
    retry: 1,
  },
});
