/**
 * 「本地分析与托管的隔离」在真实 MySQL 上的演练（修订稿 §8 第 1 期验收「隔离」）。
 *
 * 单元测试用替身连接验证的是判断；这里验证的是 SQL 本身——迁移 085 能执行，
 * 闸门、启动恢复、补跑、定时扫描新加的连接和条件在真实的表结构上成立、结果是对的。
 *
 *   1. 迁移从零建表（含 085）。
 *   2. 一个托管产品和一个客户端分析的产品，各有一个 queued 的 run。另给客户端的产品直接插一行
 *      client_upload 的 run（现实中发布事务外看不到这种行，这里插它是为了验证谓词）。
 *   3. 入队：客户端的产品被拒（analysis_mode_is_client），不留 run 行；托管的产品过了闸门。
 *   4. 启动恢复：只派发托管产品的那一个；客户端产品的 running run 不被重排。
 *   5. 积压补跑：只认领托管产品的那一个；客户端产品的 queued run 不被派发，也不被标成 superseded。
 *   6. runAnalysis：客户端产品的 run、client_upload 的 run 都被标失败，原因 analysis_mode_is_client。
 *   7. 定时扫描：客户端的产品不在结果里，它的 pending 计数原样留着。
 *
 * 只接受库名以 codelphi_test_executor 开头的库，每次运行都先删掉重建；绝不读 DATABASE_URL。
 *
 * 用法（在仓库根目录）：
 *   ANALYSIS_EXECUTOR_VERIFY_DATABASE_URL="mysql://user:pass@127.0.0.1:3306/codelphi_test_executor" \
 *     npx tsx scripts/verify-analysis-executor-mysql.ts
 */
import type { Pool } from "mysql2/promise";
import { enqueueRunWithReservation, BillingError } from "../lib/billing/core";
import { dispatchStuckQueuedRuns, recoverInterruptedRuns, type QueuedRunGate } from "../lib/analysis-recovery";
import { runAnalysisTriggerSweepOnce } from "../lib/analysis-trigger";
import { runAnalysis } from "../lib/analysis";
import { ClientAnalysisError, CLIENT_MODE_ERROR } from "../lib/analysis-executor";
import { insertIdOf, withScratchDatabase } from "./scratch-database";

const SCRATCH_PREFIX = "codelphi_test_executor";
const ENV_URL = "ANALYSIS_EXECUTOR_VERIFY_DATABASE_URL";
const QUEUED_RUN_RECOVERY_THRESHOLD_MINUTES = 10;

type Row = Record<string, unknown>;

function mustBe(ok: boolean, message: string, details: unknown): void {
  if (!ok) throw new Error(`${message}；实际是 ${JSON.stringify(details)}`);
}

async function rowsOf(pool: Pool, statement: string, parameters: Array<string | number | null> = []): Promise<Row[]> {
  const [rows] = (await pool.execute(statement, parameters)) as unknown as [Row[], unknown];
  return rows;
}

async function seed(pool: Pool) {
  const organizationId = insertIdOf(await pool.execute("INSERT INTO organizations (slug, name) VALUES (?, ?)", ["executor-org", "Executor Org"]));
  const serverProductId = insertIdOf(await pool.execute("INSERT INTO products (organization_id, slug, name, description) VALUES (?, ?, ?, ?)", [organizationId, "server-product", "Server", ""]));
  const clientProductId = insertIdOf(await pool.execute("INSERT INTO products (organization_id, slug, name, description, analysis_executor) VALUES (?, ?, ?, ?, 'client')", [organizationId, "client-product", "Client", ""]));
  const serverRepositoryId = insertIdOf(await pool.execute("INSERT INTO repositories (product_id, provider, owner, name, default_branch) VALUES (?, 'github', 'verify', 'server', 'main')", [serverProductId]));
  const clientRepositoryId = insertIdOf(await pool.execute("INSERT INTO repositories (product_id, provider, owner, name, default_branch) VALUES (?, 'github', 'verify', 'client', 'main')", [clientProductId]));
  const insertRun = async (repositoryId: number, triggerType: string, afterSha: string) =>
    insertIdOf(await pool.execute("INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status) VALUES (?, ?, NULL, ?, 'queued')", [repositoryId, triggerType, afterSha]));
  return {
    serverRepositoryId,
    clientRepositoryId,
    serverQueued: await insertRun(serverRepositoryId, "manual", "sha-server"),
    clientQueued: await insertRun(clientRepositoryId, "manual", "sha-client"),
    clientUpload: await insertRun(clientRepositoryId, "client_upload", "sha-upload"),
  };
}

type World = Awaited<ReturnType<typeof seed>>;

const count = (rows: Row[]) => Number(rows[0]?.count ?? -1);

/** 第 3 步：入队的闸门。 */
async function verifyEnqueueGate(pool: Pool, world: World): Promise<string[]> {
  const clientError = await enqueueRunWithReservation({ repositoryId: world.clientRepositoryId, beforeSha: null, afterSha: "sha-new", trigger: "push", requestId: "verify-client" }).then(
    () => null,
    (error: unknown) => error,
  );
  mustBe(clientError instanceof ClientAnalysisError, "客户端分析的产品入队应当被 ClientAnalysisError 拒绝", String(clientError));
  mustBe(count(await rowsOf(pool, "SELECT COUNT(*) AS count FROM analysis_runs WHERE repository_id = ?", [world.clientRepositoryId])) === 2, "被拒的入队不能留下 run 行", world);
  // 托管的产品：闸门放行，往下走到锁计费账户——临时库没有账户，所以停在那里的 BillingError 上。
  const serverError = await enqueueRunWithReservation({ repositoryId: world.serverRepositoryId, beforeSha: null, afterSha: "sha-new", trigger: "push", requestId: "verify-server" }).then(
    () => null,
    (error: unknown) => error,
  );
  mustBe(serverError instanceof BillingError, "托管的产品应当过闸门（停在缺少计费账户的 BillingError 上）", String(serverError));
  return [`入队：客户端的产品被拒（${CLIENT_MODE_ERROR}），不留 run 行；托管的产品过了闸门`];
}

/** 第 4 步：启动恢复。 */
async function verifyStartupRecovery(pool: Pool, world: World): Promise<string[]> {
  await pool.execute("UPDATE analysis_runs SET status = 'running' WHERE id = ?", [world.clientUpload]);
  const dispatched: number[] = [];
  const result = await recoverInterruptedRuns(async (runId) => { dispatched.push(runId); }, undefined, gatePass);
  mustBe(JSON.stringify(dispatched) === JSON.stringify([world.serverQueued]), "启动恢复只应当派发托管产品的那一个 run", { dispatched, world });
  mustBe(result.requeued === 0, "客户端产品的 running run 不应当被重排", result);
  const upload = await rowsOf(pool, "SELECT status FROM analysis_runs WHERE id = ?", [world.clientUpload]);
  mustBe(upload[0]?.status === "running", "client_upload 的 run 留在原状态", upload);
  return ["启动恢复：只派发托管产品的 run；客户端产品的 running run 不被重排"];
}

/** 第 5 步：积压补跑。 */
async function verifyStuckRecovery(pool: Pool, world: World): Promise<string[]> {
  // 上一步认领过托管的 run：把认领标记清掉，并让所有 queued 的 run 都超过阈值。
  await pool.execute("UPDATE analysis_runs SET started_at = NULL, created_at = DATE_SUB(NOW(3), INTERVAL ? MINUTE) WHERE status = 'queued'", [QUEUED_RUN_RECOVERY_THRESHOLD_MINUTES + 1]);
  const dispatched: number[] = [];
  const result = await dispatchStuckQueuedRuns(async (runId) => { dispatched.push(runId); }, undefined, gatePass);
  mustBe(JSON.stringify(dispatched) === JSON.stringify([world.serverQueued]), "积压补跑只应当认领托管产品的那一个 run", { dispatched, world });
  mustBe(result.superseded === 0, "客户端产品的 queued run 不应当被标成 superseded", result);
  const client = await rowsOf(pool, "SELECT status FROM analysis_runs WHERE id = ?", [world.clientQueued]);
  mustBe(client[0]?.status === "queued", "客户端产品的 queued run 留在 queued", client);
  return ["积压补跑：只认领托管产品的 run；客户端产品的 queued run 不派发、不标 superseded"];
}

/** 第 6 步：runAnalysis 在认领之前拒绝。 */
async function verifyRunRefusal(pool: Pool, world: World): Promise<string[]> {
  for (const [runId, expected] of [[world.clientQueued, /^analysis_mode_is_client: this product/], [world.clientUpload, /^analysis_mode_is_client: a client_upload run/]] as const) {
    await pool.execute("UPDATE analysis_runs SET status = 'queued' WHERE id = ?", [runId]);
    await runAnalysis(runId);
    const rows = await rowsOf(pool, "SELECT status, error_message AS errorMessage FROM analysis_runs WHERE id = ?", [runId]);
    mustBe(rows[0]?.status === "failed" && expected.test(String(rows[0]?.errorMessage)), `run ${runId} 应当被标失败并写明 ${CLIENT_MODE_ERROR}`, rows);
  }
  return ["runAnalysis：客户端产品的 run 和 client_upload 的 run 都被标失败，原因 analysis_mode_is_client"];
}

/** 第 7 步：定时扫描。 */
async function verifyTriggerSweep(pool: Pool, world: World): Promise<string[]> {
  await pool.execute("UPDATE repositories SET analysis_trigger = 'daily', analysis_trigger_hour = HOUR(CURRENT_TIMESTAMP), pending_push_count = 1 WHERE id IN (?, ?)", [world.serverRepositoryId, world.clientRepositoryId]);
  const outcome = await runAnalysisTriggerSweepOnce({
    queue: async () => {
      throw new Error("托管的产品没有已成功的分析，扫描不应当走到入队");
    },
    getAdapter: () => ({ getRepository: async () => ({ defaultBranch: "main" }), getBranchHead: async () => "sha-head" }) as never,
  });
  mustBe(outcome.analyzed === 0 && outcome.errors.length === 0 && outcome.noCommits === 1, "定时扫描只应当处理托管的产品", outcome);
  const pending = await rowsOf(pool, "SELECT pending_push_count AS pending FROM repositories WHERE id = ?", [world.clientRepositoryId]);
  mustBe(Number(pending[0]?.pending) === 1, "客户端产品的 pending 计数原样留着", pending);
  return ["定时扫描：客户端的产品不在结果里，它的 pending 计数原样留着"];
}

const gatePass: QueuedRunGate = async () => ({ dispatch: true, reason: "gate_passed" });

async function main(): Promise<void> {
  const url = process.env[ENV_URL];
  if (!url) throw new Error(`缺少 ${ENV_URL}：这个脚本只认它，不读 DATABASE_URL（它会删库重建，不能指向别的库）`);
  await withScratchDatabase({ url, prefix: SCRATCH_PREFIX, envName: ENV_URL }, async (pool, info) => {
    const world = await seed(pool);
    console.log(`临时库 ${info.database}，服务器 MySQL ${info.serverVersion}，${info.migrations} 个迁移文件。`);
    for (const line of [
      ...(await verifyEnqueueGate(pool, world)),
      ...(await verifyStartupRecovery(pool, world)),
      ...(await verifyStuckRecovery(pool, world)),
      ...(await verifyRunRefusal(pool, world)),
      ...(await verifyTriggerSweep(pool, world)),
    ]) console.log(`  ${line}`);
  });
  console.log("全部通过");
}

if (process.argv[1]?.endsWith("verify-analysis-executor-mysql.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
