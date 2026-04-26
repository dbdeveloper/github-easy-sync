import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The Obsidian runtime isn't available under Node — alias to the same
    // mock-obsidian.ts the benchmark script uses. Pure-function tests then
    // run unchanged: anything that touches the actual Obsidian API would
    // need integration-style tests, which we'll add later.
    alias: {
      obsidian: path.resolve(__dirname, "mock-obsidian.ts"),
    },
  },
});
