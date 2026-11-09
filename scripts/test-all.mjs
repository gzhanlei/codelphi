#!/usr/bin/env node
// Full-suite runner for this sandbox.
//
// Why: vitest's default pool starts one worker per core. This environment
// reclaims the system temp directory while a run is in progress, so workers
// lose their broker socket (ECONNREFUSED .../broker.sock) and the 167-file
// suite stalls with zero completed files. One worker per process, with TMPDIR
// pinned inside the project, keeps every run bounded and its socket stable.
//
// A few test files also collide on vi.mock factories when they share one
// module graph (vmThreads reuses the transformed graph between files). A file
// that fails inside a shard is therefore re-run in its own process: if it
// passes there it was an isolation issue, if it still fails it is a real
// failure. Passing files inside a failed shard are trusted (JSON reporter says
// so per file) and are not re-run.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const scratch = join(root, "node_modules", ".vitest-tmp");
mkdirSync(scratch, { recursive: true });

const files = readdirSync(join(root, "tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/${name}`);
const shardCount = Math.max(1, Math.min(files.length, Number(process.env.TEST_SHARDS ?? 12)));
const env = { ...process.env, TMPDIR: scratch, NO_COLOR: "1" };

const runId = Date.now();
let serial = 0;
function runChunk(chunk, label) {
  // Unique per invocation, so no old report has to be removed first (the
  // host's fs shim rejects rmSync on this machine).
  const output = join(scratch, `${label}-${runId}-${++serial}.json`);
  const args = [vitest, "run", "--maxWorkers=1", "--reporter=json", `--outputFile=${output}`, ...chunk];
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
  let failed = [];
  let parsed = false;
  try {
    const report = JSON.parse(readFileSync(output, "utf8"));
    failed = (report.testResults ?? [])
      .filter((entry) => entry.status === "failed")
      .map((entry) => relative(root, entry.name).replaceAll("\\", "/"));
    parsed = true;
  } catch {
    // No report means the runner itself died; treat the whole chunk as failed.
    failed = [...chunk];
  }
  return { code: result.status ?? 1, failed, parsed, stderr: result.stderr ?? "" };
}

function splitIntoShards(items, count) {
  const shards = Array.from({ length: count }, () => []);
  items.forEach((item, index) => shards[index % count].push(item));
  return shards.filter((shard) => shard.length > 0);
}

const shards = splitIntoShards(files, shardCount);
const isolatedPasses = [];
const realFailures = [];
const startedAt = Date.now();

for (const [index, chunk] of shards.entries()) {
  const label = `shard-${index + 1}`;
  const result = runChunk(chunk, label);
  if (result.code === 0) {
    console.log(`[${index + 1}/${shards.length}] ${chunk.length} files passed`);
    continue;
  }
  console.log(`[${index + 1}/${shards.length}] ${result.failed.length}/${chunk.length} failed; isolating ${result.failed.length} file(s)`);
  for (const file of result.failed) {
    const isolated = runChunk([file], `isolated-${basename(file, ".test.ts")}`);
    if (isolated.code === 0) {
      isolatedPasses.push(file);
    } else {
      realFailures.push(file);
      if (!isolated.parsed) console.error(isolated.stderr.slice(-1200));
    }
  }
}

const seconds = Math.round((Date.now() - startedAt) / 1000);
console.log(`\n${files.length} test files in ${shards.length} shards, ${seconds}s`);
console.log(`${isolatedPasses.length} file(s) passed in an isolated process (mock-factory collision in a shared shard)`);
for (const file of isolatedPasses) console.log(`  isolated: ${file}`);
console.log(`${realFailures.length} real failure(s)`);
for (const file of realFailures) console.log(`  FAILED: ${file}`);
process.exit(realFailures.length > 0 ? 1 : 0);
