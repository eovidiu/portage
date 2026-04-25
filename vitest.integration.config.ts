import { defineConfig } from "vitest/config";

// Integration tests run in Node (not the Workers sandbox) so they can:
// 1. Call the Neon Management API via https to create/delete branches
// 2. Use @neondatabase/serverless over HTTP for schema application
// 3. Import src/ modules that use globalThis.crypto (available in Node 18+)
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    // Branch creation takes 5-15s; allow generous timeout per test file
    testTimeout: 120_000,
    // Run test files sequentially to avoid branch naming collisions and
    // to respect Neon's branch creation concurrency limits
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // No coverage for integration tests — they exercise real code paths
    // already covered by the unit suite; measuring here would double-count
  },
});
