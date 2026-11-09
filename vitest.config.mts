import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // CLI scripts import "dotenv/config" for their .env side effect. Tests
      // inject their own DB stubs and never need a real .env; the VM pool
      // also cannot evaluate that package's CJS wrapper. Stub it at the test
      // boundary instead of loading it into every test file's module graph.
      { find: /^dotenv\/config$/, replacement: fileURLToPath(new URL("./tests/stubs/dotenv-config.ts", import.meta.url)) },
      { find: "@", replacement: projectRoot },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Measured on this machine: the default pool (one worker per core) loses
    // its broker socket when the sandbox reclaims the system temp directory,
    // so the 167-file suite stalls with zero completed files. `npm test` runs
    // shards in separate processes (scripts/test-all.mjs); this config is the
    // per-shard setting: one worker, vmThreads reusing the transformed module
    // graph. Files whose vi.mock factories collide inside a shard are
    // re-run in their own process by that script.
    pool: "vmThreads",
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.ts", "scripts/**/*.ts"],
    },
  },
});
