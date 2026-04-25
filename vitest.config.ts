import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
    coverage: {
      provider: "istanbul",
      exclude: ["db/schema.sql", "node_modules/**", "dist/**", "vitest.config.ts"],
    },
  },
});
