import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
      },
      exclude: ["db/schema.sql", "node_modules/**", "dist/**", "vitest.config.ts"],
    },
  },
});
