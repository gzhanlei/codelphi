/**
 * 托管落库路径的零回归对照（客户端分析修订稿 §8 第 1 期验收「托管零回归」）。
 *
 * 在一个空的临时库里从零建表，灌入一份固定的账本，然后用真实的 saveResult 走四个固定场景，
 * 把每个场景发给数据库的每一条语句和参数按顺序录下来：
 *   1. first-version：没有上一版，最新的 run，带覆盖率回执和带补丁的变更文件；
 *   2. full-on-existing-version：有上一版、有人工条目和墓碑，全量重新分析；
 *   3. incremental-on-existing-version：有上一版，只分析受影响的功能；
 *   4. superseded-run：被后来的 run 超越的 run，带着开工时的基线版本号。
 *
 *   --record     把录到的写进目录，每个场景一个文件。
 *   不带 --record 重录一遍，和目录里已有的逐字节比较；有任何不同就失败。
 *
 * 只接受库名以 codelphi_test_save_result 开头的库，每次运行都先删掉重建；绝不读 DATABASE_URL。
 * 它自己和它启动的子进程都不走 TLS：连接生产时的 TLS 设置不在这里验证。
 *
 * 用法（在仓库根目录）：
 *   SAVE_RESULT_BASELINE_DATABASE_URL="mysql://user:pass@127.0.0.1:3306/codelphi_test_save_result" \
 *     npx tsx scripts/verify-save-result-baseline.ts [--record]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { type RunContext, saveResult } from "../lib/analysis";
import { type AnalysisResult } from "../lib/ai";
import { databaseConfig } from "../lib/database-config";

const SCRATCH_PREFIX = "codelphi_test_save_result";
const ENV_URL = "SAVE_RESULT_BASELINE_DATABASE_URL";
const BASELINE_DIR = "tests/fixtures/save-result-baseline";
const SCENARIOS = ["first-version", "full-on-existing-version", "incremental-on-existing-version", "superseded-run"] as const;

type Scenario = (typeof SCENARIOS)[number];

interface Statement {
  sql: string;
  params: unknown[];
}

type Recording = Record<Scenario, Statement[]>;

/** 编号全由库分配：迁移会先插入一些行（比如默认组织），写死的号会和它们撞上。 */
interface World {
  organizationId: number;
  productId: number;
  repositoryId: number;
}

const insertIdOf = (result: unknown): number => Number((result as [{ insertId: number }, unknown])[0].insertId);

/** 从连接地址里取出库名，并确认它是一个可以随便删了重建的临时库。 */
function scratchDatabase(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${ENV_URL} 不是合法的连接地址`);
  }
  const name = parsed.pathname.replace(/^\//, "");
  if (parsed.protocol !== "mysql:" || !name.startsWith(SCRATCH_PREFIX) || !/^[0-9a-z_]*$/.test(name.slice(SCRATCH_PREFIX.length))) {
    throw new Error(`拒绝：这个脚本会删掉并重建它指向的库，库名必须以 ${SCRATCH_PREFIX} 开头（收到的是「${name}」）`);
  }
  return name;
}

/** 参数里能放进 JSON 的原样放；日期和二进制换成带标记的普通值，undefined 记成 null。 */
function plain(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $buffer: value.toString("hex") };
  return value === undefined ? null : value;
}

/** 把连接池换成一个会记账的替身：语句和参数原样交给真连接，同时按顺序记进 current() 指的数组。 */
function recordingPool(pool: Pool, current: () => Statement[]): Pool {
  const record = async (target: Pool | PoolConnection, sql: string, params?: unknown[]) => {
    current().push({ sql, params: (params ?? []).map(plain) });
    return (target.execute as (sql: string, values?: unknown[]) => Promise<unknown>)(sql, params);
  };
  const connection = (real: PoolConnection): PoolConnection =>
    new Proxy(real, {
      get(target, property) {
        if (property === "execute") return (sql: string, params?: unknown[]) => record(target, sql, params);
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  return {
    execute: (sql: string, params?: unknown[]) => record(pool, sql, params),
    getConnection: async () => connection(await pool.getConnection()),
  } as unknown as Pool;
}

const runOf = (world: World, id: number, beforeSha: string | null, afterSha: string): RunContext => ({
  id,
  repositoryId: world.repositoryId,
  productId: world.productId,
  owner: "baseline",
  name: "repo",
  beforeSha,
  afterSha,
  connectionId: null,
  provider: "github",
  organizationId: world.organizationId,
  productSlug: "baseline",
  productName: "Baseline",
});

const scenarioOf = (reference: string, path: string, startLine: number, outcome: string) => ({
  reference,
  context: "用户使用产品",
  action: `做 ${reference} 对应的事`,
  outcome,
  category: "happy" as const,
  evidence: [{ path, startLine }],
});

const changeOf = (sha: string, files: Array<{ path: string; status: string; patch: string }>) => ({
  message: `change ${sha}`,
  committedAt: "2026-11-01T00:00:00.000Z",
  url: `https://github.com/baseline/repo/commit/${sha}`,
  files,
});

const coverage = (assembled: number, total: number) => ({
  implFilesAssembled: assembled,
  implFilesTotal: total,
  implBytesAssembled: assembled * 100,
  implBytesTotal: total * 100,
  coverageRatio: assembled / total,
  partitionsUsed: 1,
  partitionsCapped: false,
  diffTotalPaths: null,
  diffSelectedPaths: null,
  diffOmittedPaths: null,
  primaryRangesOmitted: null,
});

const AUTH_CODE_PATCH = "@@ -10,2 +10,3 @@\n-const attempts = 1;\n+const attempts = 2;\n+const delay = 10;\n const retry = true;\n";
const DOC_COMMENT_PATCH = "@@ -1,2 +1,2 @@\n-# 旧标题\n+# 新标题\n\n正文\n";

const firstPublication: AnalysisResult = {
  product: { description: "Baseline product description.", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
  release: { title: "First release", summary: "First summary" },
  changes: [],
  features: [
    { name: "Login", summary: "Login handles sign-in.", scenarios: [scenarioOf("HP-1", "lib/auth.ts", 10, "进入首页"), scenarioOf("EC-1", "lib/auth.ts", 20, "提示密码错误")] },
    { name: "Billing", summary: "Billing handles invoices.", scenarios: [scenarioOf("HP-1", "lib/billing.ts", 5, "看到账单")] },
  ],
};

const secondPublication: AnalysisResult = {
  product: { description: "Baseline product description.", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
  release: { title: "Second release", summary: "Second summary" },
  changes: [{ featureName: "Login", kind: "changed", description: "登录重试次数变了", userImpact: "", evidence: [{ path: "lib/auth.ts", startLine: 10 }] }],
  features: [
    // HP-1 的锚点（第 10 行）落进了改动区间：重新提取，措辞变了。EC-1（第 20 行）没被碰到，但这次没提取出来。
    { name: "Login", summary: "Login handles sign-in.", scenarios: [scenarioOf("HP-1", "lib/auth.ts", 11, "进入首页，重试次数增加")] },
    { name: "Exports", summary: "Exports data.", scenarios: [scenarioOf("HP-1", "lib/export.ts", 3, "导出成功")] },
  ],
};

const thirdPublication: AnalysisResult = {
  product: { description: "Baseline product description.", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
  release: { title: "Third release", summary: "Third summary" },
  changes: [],
  features: [{ name: "Login", summary: "Login handles sign-in.", scenarios: [scenarioOf("HP-1", "lib/auth.ts", 11, "进入首页"), scenarioOf("EC-1", "lib/auth.ts", 20, "提示密码错误")] }],
};

async function insertRun(pool: Pool, world: World, beforeSha: string | null, afterSha: string): Promise<number> {
  return insertIdOf(await pool.execute("INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status) VALUES (?, 'manual', ?, ?, 'running')", [world.repositoryId, beforeSha, afterSha]));
}

async function seed(pool: Pool): Promise<World> {
  const organizationId = insertIdOf(await pool.execute("INSERT INTO organizations (slug, name) VALUES (?, ?)", ["baseline-org", "Baseline Org"]));
  const productId = insertIdOf(await pool.execute("INSERT INTO products (organization_id, slug, name, description) VALUES (?, ?, ?, ?)", [organizationId, "baseline", "Baseline", ""]));
  const repositoryId = insertIdOf(await pool.execute("INSERT INTO repositories (product_id, provider, owner, name, default_branch) VALUES (?, ?, ?, ?, ?)", [productId, "github", "baseline", "repo", "main"]));
  return { organizationId, productId, repositoryId };
}

/** 人工条目和墓碑：一个在用的人工功能，一个被人工下线的功能，一个被人工下线的场景。 */
async function seedManualRows(pool: Pool, world: World): Promise<void> {
  const inserted = await Promise.all([
    pool.execute("INSERT INTO features (product_id, name, summary, source, active) VALUES (?, ?, ?, 'manual', 1)", [world.productId, "Manual notes", "人工维护的说明"]),
    pool.execute("INSERT INTO features (product_id, name, summary, source, active) VALUES (?, ?, ?, 'manual', 0)", [world.productId, "Legacy export", "被人工下线的导出"]),
  ]);
  const manual = insertIdOf(inserted[0]);
  const retired = insertIdOf(inserted[1]);
  await pool.execute("INSERT INTO scenarios (feature_id, reference, context, action, outcome, category, source, evidence) VALUES (?, 'HP-1', '人工', '查看说明', '看到人工说明', 'happy', 'manual', '[]')", [manual]);
  await pool.execute("INSERT INTO scenarios (feature_id, reference, context, action, outcome, category, source, active, evidence) VALUES (?, 'EC-1', '人工', '旧导出', '旧的导出结果', 'edge', 'manual', 0, '[]')", [retired]);
}

/** 走一遍全部场景，返回每个场景的录音。任何一步的结果不对都抛错，免得录下一份没有意义的基线。 */
export async function rehearse(pool: Pool): Promise<Recording> {
  const world = await seed(pool);
  const recording = Object.fromEntries(SCENARIOS.map((scenario) => [scenario, [] as Statement[]])) as Recording;
  let current: Statement[] = recording["first-version"];
  globalThis.codelphiDb = recordingPool(pool, () => current);

  const firstRun = await insertRun(pool, world, null, "sha-1");
  current = recording["first-version"];
  await saveResult(runOf(world, firstRun, null, "sha-1"), firstPublication, changeOf("sha-1", [
    { path: "lib/auth.ts", status: "modified", patch: AUTH_CODE_PATCH },
    { path: "README.md", status: "modified", patch: DOC_COMMENT_PATCH },
  ]), null, coverage(2, 3));

  await seedManualRows(pool, world);
  const secondRun = await insertRun(pool, world, "sha-1", "sha-2");
  current = recording["full-on-existing-version"];
  await saveResult(runOf(world, secondRun, "sha-1", "sha-2"), secondPublication, changeOf("sha-2", [
    { path: "lib/auth.ts", status: "modified", patch: AUTH_CODE_PATCH },
    { path: "README.md", status: "modified", patch: DOC_COMMENT_PATCH },
  ]), null, coverage(3, 3));

  const thirdRun = await insertRun(pool, world, "sha-2", "sha-3");
  current = recording["incremental-on-existing-version"];
  await saveResult({ ...runOf(world, thirdRun, "sha-2", "sha-3"), analyzeMode: "incremental" }, thirdPublication, changeOf("sha-3", [
    { path: "lib/auth.ts", status: "modified", patch: AUTH_CODE_PATCH },
    { path: "lib/billing.ts", status: "modified", patch: AUTH_CODE_PATCH },
  ]), new Set(["login"]), coverage(2, 3));

  // 后来的 run 分析的是下一个提交：同一个提交不能有两个活跃的 run（analysis_runs_active_unique）。
  const supersededRun = await insertRun(pool, world, "sha-3", "sha-4");
  await insertRun(pool, world, "sha-4", "sha-5");
  current = recording["superseded-run"];
  let superseded = "";
  try {
    await saveResult({ ...runOf(world, supersededRun, "sha-3", "sha-4"), baseSpecVersionId: 3, baseCapturedAt: new Date("2026-11-02T00:00:00.000Z") }, secondPublication, changeOf("sha-4", []), null);
  } catch (error) {
    superseded = error instanceof Error ? error.message : String(error);
  }
  if (!/^Analysis superseded by run \d+$/.test(superseded)) throw new Error(`被超越的 run 应当在提交之后抛出「Analysis superseded」，实际是「${superseded}」`);

  for (const scenario of SCENARIOS) {
    if (recording[scenario].length === 0) throw new Error(`场景 ${scenario} 一条语句都没录到`);
  }
  const [carried] = (await pool.execute("SELECT COUNT(*) AS count FROM spec_scenarios s JOIN spec_features f ON f.id = s.spec_feature_id WHERE f.spec_version_id = 2 AND f.name = 'Login'")) as [{ count: number }[], unknown];
  if (Number(carried[0].count) !== 2) throw new Error(`第二个版本里 Login 应当有 2 条场景（重新提取的 HP-1 和沿用的 EC-1），实际是 ${carried[0].count}`);
  return recording;
}

function runMigrations(): number {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`迁移失败（退出码 ${result.status}）：\n${output.slice(-3000)}`);
  return output.split("\n").filter((line) => line.startsWith("Applied ")).length;
}

/** 逐字节比较。返回第一条对不上的语句的说明；全部相同就返回空。 */
function firstDifference(scenario: Scenario, expected: Statement[], actual: Statement[]): string {
  const size = Math.max(expected.length, actual.length);
  for (let index = 0; index < size; index += 1) {
    const left = JSON.stringify(expected[index]) ?? "（没有这条语句）";
    const right = JSON.stringify(actual[index]) ?? "（没有这条语句）";
    if (left !== right) return `场景 ${scenario} 第 ${index + 1} 条语句不同：\n  基线：${left.slice(0, 1500)}\n  这次：${right.slice(0, 1500)}`;
  }
  return "";
}

export function parseArgs(argv: readonly string[]): { record: boolean } {
  let record = false;
  for (const argument of argv) {
    if (argument === "--record") record = true;
    else throw new Error(`用法：[--record]；不认识「${argument}」`);
  }
  return { record };
}

async function main(): Promise<void> {
  const url = process.env[ENV_URL];
  if (!url) throw new Error(`缺少 ${ENV_URL}：这个脚本只认它，不读 DATABASE_URL（它会删库重建，不能指向别的库）`);
  const options = parseArgs(process.argv.slice(2));
  const database = scratchDatabase(url);
  // 仓库的连接池从这里读配置。只改这个进程和它启动的子进程，不碰别的。
  process.env.DATABASE_URL = url;
  process.env.DATABASE_SSL = "false";
  // 本机的临时库不走 TLS。
  const config = { ...databaseConfig(), ssl: undefined };
  const admin = await mysql.createConnection({ ...config, database: undefined });
  let pool: Pool | undefined;
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const migrations = runMigrations();
    pool = mysql.createPool(config);
    const recording = await rehearse(pool);
    const lines = SCENARIOS.map((scenario) => `${scenario}：${recording[scenario].length} 条语句`);
    if (options.record) {
      mkdirSync(BASELINE_DIR, { recursive: true });
      for (const scenario of SCENARIOS) writeFileSync(join(BASELINE_DIR, `${scenario}.json`), `${JSON.stringify(recording[scenario], null, 1)}\n`);
      console.log(`临时库 ${database}，${migrations} 个迁移文件。基线已写入 ${BASELINE_DIR}：`);
      for (const line of lines) console.log(`  ${line}`);
      return;
    }
    const differences = SCENARIOS.flatMap((scenario) => {
      const expected = JSON.parse(readFileSync(join(BASELINE_DIR, `${scenario}.json`), "utf8")) as Statement[];
      const difference = firstDifference(scenario, expected, recording[scenario]);
      return difference ? [difference] : [];
    });
    if (differences.length > 0) throw new Error(`托管落库路径发给数据库的语句和基线不同：\n${differences.join("\n")}`);
    console.log(`临时库 ${database}，${migrations} 个迁移文件。和基线逐字节相同：`);
    for (const line of lines) console.log(`  ${line}`);
  } finally {
    await pool?.end();
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await admin.end();
    }
  }
}

if (process.argv[1]?.endsWith("verify-save-result-baseline.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
