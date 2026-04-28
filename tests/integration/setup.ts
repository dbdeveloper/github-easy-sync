// Validate that the integration env is configured. We don't throw
// here — vitest's `describe.skipIf(...)` in each test file uses
// `integrationEnabled()` to skip cleanly when env is missing. This
// file just emits one warning so a developer running `pnpm
// test:integration` without setup understands why nothing ran.

const required = ["GITHUB_TOKEN", "INT_TEST_OWNER", "INT_TEST_REPO"];
const missing = required.filter((k) => !process.env[k]);

if (missing.length > 0) {
  console.warn(
    `\n[integration tests] Missing env: ${missing.join(", ")}.\n` +
      `[integration tests] Copy .env.example to .env.test and fill in real values.\n` +
      `[integration tests] All integration tests will be skipped.\n`,
  );
}
