import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Exclude integration tests (require Node APIs, run via test:integration)
    // and e2e tests (require a running wrangler dev, run via test:e2e)
    exclude: ["tests/integration/**", "tests/e2e/**", "node_modules/**"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
    coverage: {
      provider: "istanbul",
      exclude: ["db/schema.sql", "node_modules/**", "dist/**", "vitest.config.ts", "tests/integration/**", "tests/e2e/**"],
    },
  },
});
