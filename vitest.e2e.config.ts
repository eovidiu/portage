import { defineConfig } from "vitest/config";

// E2E config: standard Node pool (no Cloudflare Workers sandbox).
// Tests run against a live `wrangler dev` process on port 8787.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run files sequentially — each file suite shares the same wrangler process.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
