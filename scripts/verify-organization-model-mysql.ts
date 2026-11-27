/**
 * 「服务端分析必须用工作区自己的模型」在真实 MySQL 上的演练。
 *
 * 单元测试用替身连接验证的是判断；这里验证的是 SQL 本身——迁移 086 能从零建表，
 * 各处闸门里那条「工作区有没有模型」的子查询在真实的表结构上结果是对的，密文真的进了表，带新列的回执写得进去。
 *
 *   1. 迁移从零建表（含 086）：organization_models 带指向 organizations 的外键，llm_call_receipts 有 model_source。
 *   2. 工作区没配模型：托管产品入队被拒（model_not_configured），没有 run、没有预留；webhook 记一条跳过并回 202，
 *      不累加待处理的推送数；定时扫描不碰它，计数原样留着；已经排队的 run 被标失败、不被认领；切成服务端分析被拒。
 *   3. 保存：库里只有密文，读出来是原来的 key，给页面看的描述里没有 key。
 *   4. 配了之后：同一个入队过了闸门（停在缺少计费账户的 BillingError 上）；webhook 走到入队；runAnalysis 认领了 run，
 *      读得到工作区的模型，一路走到取仓库那一步，那一刻（分析的范围内）绑定着的正是工作区自己的地址、key 和模型名；
 *      能切成服务端分析。
 *   5. 回执：出口在工作区的模型里发出的调用写进真实的 llm_call_receipts，model_source 是 organization；
 *      CoDelphi 自己的照旧留空。服务器自己的 AI_MODEL、AI_API_KEY 在这之前已经从环境里拿掉了。
 *   6. 删除：还有产品由服务端分析时被拒并说出是哪些；都改成客户端分析后能删；删工作区时级联。
 *
 * 全程不发网络请求：fetch 换成一调用就报错的替身（它记下被调用那一刻绑定着的模型），模型地址只是存进去、读出来，
 * 没有一次真的去连它（出口那一次故意存了一个过不了地址校验的地址，校验在解析域名之前就拒绝）。
 * 只接受库名以 codelphi_test_org_model 开头的库，每次运行都先删掉重建；绝不读 DATABASE_URL。
 *
 * 用法（在仓库根目录）：
 *   ORGANIZATION_MODEL_VERIFY_DATABASE_URL="mysql://user:pass@127.0.0.1:3306/codelphi_test_org_model" \
 *     npx tsx scripts/verify-organization-model-mysql.ts
 */
import { randomBytes } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { requestStructuredCompletionDetailed } from "../lib/ai";
import { queueAnalysis, runAnalysis } from "../lib/analysis";
import { ClientAnalysisError, MODEL_NOT_CONFIGURED, ModelNotConfiguredError, modelRunRefusal, switchAnalysisExecutor } from "../lib/analysis-executor";
import { runAnalysisTriggerSweepOnce } from "../lib/analysis-trigger";
import { BillingError, enqueueRunWithReservation } from "../lib/billing/core";
import { recordLlmCallReceipt } from "../lib/billing/cost-receipt";
import { processGitHubWebhook, type EnqueueInTransactionInput } from "../lib/github-webhook";
import { ModelInUseError, ModelUrlError, currentOrganizationModel, deleteOrganizationModel, describeOrganizationModel, loadOrganizationModel, saveOrganizationModel, withOrganizationModel } from "../lib/organization-model";
import { insertIdOf, withScratchDatabase } from "./scratch-database";

const SCRATCH_PREFIX = "codelphi_test_org_model";
const ENV_URL = "ORGANIZATION_MODEL_VERIFY_DATABASE_URL";
const PLAIN_KEY = "sk-plain-secret-of-the-workspace";
const MODEL = { baseUrl: "https://api.example/v1", apiKey: PLAIN_KEY, model: "k3-256k", by: "verify" };
const NO_NETWORK = "the rehearsal makes no network requests";
const REACHED_REPOSITORY = "the sweep reached the repository";

/** fetch 的替身记下的东西：被调用过几次，以及每一次被调用时分析的范围内绑定着哪个模型（没有绑定就是 null）。 */
const network = { calls: 0, bound: [] as unknown[] };

type Row = Record<string, unknown>;
type Execute = (statement: string, parameters?: Array<string | number | null>) => Promise<unknown>;

function mustBe(ok: boolean, message: string, details: unknown): void {
  if (!ok) throw new Error(`${message}；实际是 ${JSON.stringify(details)}`);
}

async function rowsOf(pool: Pool, statement: string, parameters: Array<string | number | null> = []): Promise<Row[]> {
  const [rows] = (await pool.execute(statement, parameters)) as unknown as [Row[], unknown];
  return rows;
}

const count = async (pool: Pool, statement: string, parameters: Array<string | number | null> = []) => Number((await rowsOf(pool, statement, parameters))[0]?.count ?? -1);

const via = (pool: Pool): Execute => (statement, parameters = []) => pool.execute(statement, parameters);

/** 库里这一行的每一列都不含明文 key。 */
async function storedRow(pool: Pool, organizationId: number): Promise<Row> {
  return (await rowsOf(pool, "SELECT * FROM organization_models WHERE organization_id = ?", [organizationId]))[0] ?? {};
}

async function seed(pool: Pool) {
  const organizationId = insertIdOf(await pool.execute("INSERT INTO organizations (slug, name) VALUES (?, ?)", ["model-org", "Model Org"]));
  const bareOrganizationId = insertIdOf(await pool.execute("INSERT INTO organizations (slug, name) VALUES (?, ?)", ["bare-org", "Bare Org"]));
  const hostedProductId = insertIdOf(await pool.execute("INSERT INTO products (organization_id, slug, name, description) VALUES (?, ?, ?, ?)", [organizationId, "hosted", "Hosted", ""]));
  const clientProductId = insertIdOf(await pool.execute("INSERT INTO products (organization_id, slug, name, description, analysis_executor) VALUES (?, ?, ?, ?, 'client')", [organizationId, "client-product", "Client", ""]));
  // 托管产品的触发模式是 daily：没配模型时如果先判了触发模式，待处理的推送数会加一——第 2 步盯着它。
  const hostedRepositoryId = insertIdOf(await pool.execute("INSERT INTO repositories (product_id, provider, owner, name, default_branch, analysis_trigger) VALUES (?, 'github', 'verify', 'hosted', 'main', 'daily')", [hostedProductId]));
  const clientRepositoryId = insertIdOf(await pool.execute("INSERT INTO repositories (product_id, provider, owner, name, default_branch) VALUES (?, 'github', 'verify', 'client', 'main')", [clientProductId]));
  const queuedRun = insertIdOf(await pool.execute("INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status) VALUES (?, 'manual', NULL, 'sha-first', 'queued')", [hostedRepositoryId]));
  return { organizationId, bareOrganizationId, hostedProductId, clientProductId, hostedRepositoryId, clientRepositoryId, queuedRun };
}

type World = Awaited<ReturnType<typeof seed>>;

const pushInput = (deliveryId: string | null) => ({
  rawBody: JSON.stringify({ ref: "refs/heads/main", before: "0000000000000000000000000000000000000000", after: "d8e7f3c2b1a0965478e3f2a1b0c9d8e7f3a2b1c0", repository: { full_name: "verify/hosted" } }),
  event: "push",
  signature: "signature",
  secret: "secret",
  deliveryId,
});

/** webhook 的依赖：仓库找得到，入队记一笔（不真的入队——临时库没有计费账户）。 */
function webhookDependencies(world: World) {
  const enqueued: EnqueueInTransactionInput[] = [];
  return {
    enqueued,
    verify: () => true,
    findRepository: async () => ({ id: world.hostedRepositoryId, defaultBranch: "main" }),
    queue: (repositoryId: number, before: string, after: string) => queueAnalysis(repositoryId, before, after, "push"),
    enqueue: async (input: EnqueueInTransactionInput) => {
      enqueued.push(input);
      return { runId: 4242, reused: false };
    },
  };
}

/** processGitHubWebhook 的应答按 push 那几条路的形状看。 */
const bodyOf = (result: { body: unknown }) => result.body as Record<string, unknown>;
const runIdOf = (result: object) => (result as { runId?: number }).runId;

const pendingOf = async (pool: Pool, repositoryId: number) => Number((await rowsOf(pool, "SELECT pending_push_count AS pending FROM repositories WHERE id = ?", [repositoryId]))[0]?.pending ?? -1);

/** 第 1 步：迁移从零建表。 */
async function verifySchema(pool: Pool): Promise<string[]> {
  const column = await rowsOf(pool, "SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_call_receipts' AND COLUMN_NAME = 'model_source'");
  mustBe(column.length === 1 && column[0].type === "varchar(16)" && column[0].nullable === "YES", "llm_call_receipts.model_source 应当是可空的 varchar(16)", column);
  const key = await rowsOf(pool, "SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organization_models' AND COLUMN_NAME = 'api_key_encrypted'");
  mustBe(key.length === 1 && key[0].type === "text", "api_key_encrypted 应当是 text（密文不带长度上限）", key);
  const foreignKey = await rowsOf(pool, "SELECT DELETE_RULE AS rule FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'organization_models' AND REFERENCED_TABLE_NAME = 'organizations'");
  mustBe(foreignKey.length === 1 && foreignKey[0].rule === "CASCADE", "organization_models 的外键应当指向 organizations，删组织时级联", foreignKey);
  mustBe(await count(pool, "SELECT COUNT(*) AS count FROM organization_models") === 0, "刚建好的表是空的", await rowsOf(pool, "SELECT * FROM organization_models"));
  return ["迁移 086：organization_models（text 的密文列、指向 organizations 的级联外键）和可空的 llm_call_receipts.model_source"];
}

/** 第 2 步：没配模型时，托管分析的每个入口都拒绝，而且什么都没写。 */
async function verifyNothingWithoutModel(pool: Pool, world: World): Promise<string[]> {
  const runsNow = () => count(pool, "SELECT COUNT(*) AS count FROM analysis_runs");
  const runsBefore = await runsNow();
  const refused = await enqueueRunWithReservation({ repositoryId: world.hostedRepositoryId, beforeSha: null, afterSha: "sha-new", trigger: "push", requestId: "verify-no-model" }).then(
    () => null,
    (error: unknown) => error,
  );
  mustBe(refused instanceof ModelNotConfiguredError, "没配模型时托管产品入队应当被 ModelNotConfiguredError 拒绝", String(refused));
  mustBe(await runsNow() === runsBefore, "被拒的入队不能留下 run 行", { runsBefore, runsNow: await runsNow() });
  mustBe(await count(pool, "SELECT COUNT(*) AS count FROM billing_reservations") === 0, "被拒的入队不能留下预留", await rowsOf(pool, "SELECT * FROM billing_reservations"));

  const dependencies = webhookDependencies(world);
  const staged = await processGitHubWebhook(pushInput("d-no-model"), dependencies);
  mustBe(staged.status === 202 && bodyOf(staged).accepted === false && bodyOf(staged).skipped === true && bodyOf(staged).reason === MODEL_NOT_CONFIGURED, "两阶段的 webhook 应当回 202 并说明因为没配模型而跳过", staged);
  mustBe(dependencies.enqueued.length === 0, "没配模型时 webhook 不应当走到入队", dependencies.enqueued.length);
  const skipped = await rowsOf(pool, "SELECT reason FROM skipped_pushes WHERE delivery_id = ?", ["d-no-model"]);
  mustBe(skipped.length === 1 && skipped[0].reason === MODEL_NOT_CONFIGURED, "webhook 应当记一条跳过，原因 model_not_configured", skipped);
  const delivery = await rowsOf(pool, "SELECT status FROM github_webhook_deliveries WHERE delivery_id = ?", ["d-no-model"]);
  mustBe(delivery[0]?.status === "skipped", "这次投递应当停在 skipped", delivery);
  mustBe(await pendingOf(pool, world.hostedRepositoryId) === 0, "没配模型时 webhook 不应当累加待处理的推送数（仓库是 daily 模式，先判触发模式就会加一）", await pendingOf(pool, world.hostedRepositoryId));
  mustBe(await runsNow() === runsBefore, "被拒的 webhook 不能留下 run 行", { runsBefore, runsNow: await runsNow() });

  const direct = await processGitHubWebhook(pushInput(null), webhookDependencies(world));
  mustBe(direct.status === 202 && bodyOf(direct).reason === MODEL_NOT_CONFIGURED, "不带投递身份的 webhook 也应当回 202、说明没配模型", direct);
  mustBe(await runsNow() === runsBefore, "被拒的 webhook 不能留下 run 行", { runsBefore, runsNow: await runsNow() });

  // 扫描小时设成现在：不这样的话这个仓库根本不在扫描范围内，「不碰它」就成了空话（第 4 步配了模型后再捞它一次来证明）。
  await pool.execute("UPDATE repositories SET pending_push_count = 1, analysis_trigger_hour = HOUR(CURRENT_TIMESTAMP) WHERE id = ?", [world.hostedRepositoryId]);
  const swept = await runAnalysisTriggerSweepOnce({
    queue: async () => {
      throw new Error("没配模型的产品不应当走到入队");
    },
    getAdapter: () => {
      throw new Error("没配模型的产品不应当去读仓库");
    },
  });
  mustBe(swept.analyzed === 0 && swept.deferredSkip === 0 && swept.noCommits === 0 && swept.errors.length === 0, "定时扫描不应当处理没配模型的工作区的仓库", swept);
  mustBe(await pendingOf(pool, world.hostedRepositoryId) === 1, "没配模型时待处理的计数原样留着", await pendingOf(pool, world.hostedRepositoryId));
  await pool.execute("UPDATE repositories SET pending_push_count = 0 WHERE id = ?", [world.hostedRepositoryId]);

  await runAnalysis(world.queuedRun);
  const run = await rowsOf(pool, "SELECT status, error_message AS errorMessage, started_at AS startedAt FROM analysis_runs WHERE id = ?", [world.queuedRun]);
  // 原因正好是那句拒绝的话：不带堆栈——堆栈说明它不是在认领前被拦下，而是干活之后才因为读不到配置而崩掉。
  mustBe(run[0]?.status === "failed" && run[0]?.errorMessage === modelRunRefusal() && run[0]?.startedAt === null, "已经排队的 run 应当被标失败、原因 model_not_configured，并且不被认领", run);

  const switchError = await switchAnalysisExecutor(world.clientProductId, "server").then(
    () => null,
    (error: unknown) => error,
  );
  mustBe(switchError instanceof ModelNotConfiguredError, "没配模型时把产品切成服务端分析应当被拒", String(switchError));
  const client = await rowsOf(pool, "SELECT analysis_executor AS executor FROM products WHERE id = ?", [world.clientProductId]);
  mustBe(client[0]?.executor === "client", "被拒的切换不能改产品", client);

  // 客户端分析的产品仍然先被「由客户端分析」拒绝，和模型配没配无关。
  const clientError = await enqueueRunWithReservation({ repositoryId: world.clientRepositoryId, beforeSha: null, afterSha: "sha-new", trigger: "push", requestId: "verify-client" }).then(
    () => null,
    (error: unknown) => error,
  );
  mustBe(clientError instanceof ClientAnalysisError, "客户端分析的产品入队仍然被 ClientAnalysisError 拒绝", String(clientError));
  return [
    "没配模型：入队被拒，没有 run、没有预留；webhook（两阶段和直接）记一条跳过并回 202，不累加待处理的推送数",
    "没配模型：定时扫描不碰这个仓库，计数原样留着；已排队的 run 被标失败、不被认领；切成服务端分析被拒；客户端分析的产品照旧被拒",
  ];
}

/** 第 3 步：保存。 */
async function verifySave(pool: Pool, world: World): Promise<string[]> {
  await saveOrganizationModel(via(pool), { ...MODEL, organizationId: world.organizationId });
  let row = await storedRow(pool, world.organizationId);
  mustBe(row.model === "k3-256k" && row.base_url === "https://api.example/v1" && row.created_by === "verify" && row.verified_at !== null, "保存后地址、模型名、保存人和验证时间应当在库里", row);
  mustBe(row.api_key_encrypted !== PLAIN_KEY && !JSON.stringify(row).includes(PLAIN_KEY), "库里只能有密文，任何一列都不能出现明文 key", row);
  mustBe(await count(pool, "SELECT COUNT(*) AS count FROM organization_models WHERE organization_id = ?", [world.organizationId]) === 1, "一个工作区只有一行", await count(pool, "SELECT COUNT(*) AS count FROM organization_models"));
  const loaded = await loadOrganizationModel(world.organizationId, via(pool));
  mustBe(loaded?.apiKey === PLAIN_KEY && loaded.baseUrl === "https://api.example/v1" && loaded.model === "k3-256k", "读出来应当是原来的 key、地址和模型名", loaded);
  const described = await describeOrganizationModel(world.organizationId, via(pool));
  mustBe(described?.baseUrl === "https://api.example/v1" && described.model === "k3-256k" && !JSON.stringify(described).includes(PLAIN_KEY), "给页面看的描述不含 key", described);

  // 换一份配置：还是一行，读出来是新的 key。
  await saveOrganizationModel(via(pool), { ...MODEL, apiKey: "sk-replacement-key", baseUrl: "https://other.example/api/v1/", organizationId: world.organizationId });
  row = await storedRow(pool, world.organizationId);
  mustBe(await count(pool, "SELECT COUNT(*) AS count FROM organization_models WHERE organization_id = ?", [world.organizationId]) === 1, "替换之后仍然只有一行", await count(pool, "SELECT COUNT(*) AS count FROM organization_models"));
  mustBe(row.base_url === "https://other.example/api/v1/", "地址按保存时的写法存（末尾的斜杠留着，拼完整地址时处理）", row);
  mustBe((await loadOrganizationModel(world.organizationId, via(pool)))?.apiKey === "sk-replacement-key", "替换后读出来是新 key", row.api_key_encrypted === (await storedRow(pool, world.organizationId)).api_key_encrypted);
  await saveOrganizationModel(via(pool), { ...MODEL, organizationId: world.organizationId });
  return ["保存：库里只有密文，读出来是原来的 key，描述不含 key；替换配置还是一行"];
}

/** 第 4 步：配了之后，同一个入队、同一个 webhook、同一个 run 都往前走。 */
async function verifyConfigured(pool: Pool, world: World): Promise<string[]> {
  const passed = await enqueueRunWithReservation({ repositoryId: world.hostedRepositoryId, beforeSha: null, afterSha: "sha-new", trigger: "push", requestId: "verify-with-model" }).then(
    () => null,
    (error: unknown) => error,
  );
  // 过了闸门，往下走到锁计费账户——临时库没有账户，所以停在那里的 BillingError 上。
  mustBe(passed instanceof BillingError, "配了模型之后托管的产品应当过闸门（停在缺少计费账户的 BillingError 上）", String(passed));

  const dependencies = webhookDependencies(world);
  const delivered = await processGitHubWebhook(pushInput("d-with-model"), dependencies);
  mustBe(delivered.status === 202 && bodyOf(delivered).accepted === true && runIdOf(delivered) === 4242, "配了模型之后 webhook 应当走到入队并接受这次投递", delivered);
  mustBe(dependencies.enqueued.length === 1 && dependencies.enqueued[0].repositoryId === world.hostedRepositoryId, "webhook 应当带着这个仓库入队一次", dependencies.enqueued.length);
  const queued = await rowsOf(pool, "SELECT status, run_id AS runId FROM github_webhook_deliveries WHERE delivery_id = ?", ["d-with-model"]);
  mustBe(queued[0]?.status === "queued" && queued[0]?.runId === 4242, "这次投递应当停在 queued", queued);
  mustBe(await count(pool, "SELECT COUNT(*) AS count FROM skipped_pushes WHERE delivery_id = ?", ["d-with-model"]) === 0, "接受了就不记跳过", await rowsOf(pool, "SELECT * FROM skipped_pushes"));

  // 重复投递：已终态，原样返回，不再入队。
  const again = await processGitHubWebhook(pushInput("d-with-model"), webhookDependencies(world));
  mustBe(again.status === 202 && bodyOf(again).accepted === true && runIdOf(again) === 4242, "重复的投递应当原样返回结果", again);

  // 一个新排队的 run：认领了、读得到工作区的模型，走到取仓库（第一次 GitHub 请求）那一步。fetch 的替身在那一刻记下
  // 绑定着的模型——分析的范围内绑着的就是工作区自己的，之后每一次模型调用用的也是它。
  const runId = insertIdOf(await pool.execute("INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status) VALUES (?, 'manual', NULL, 'sha-second', 'queued')", [world.hostedRepositoryId]));
  const callsBefore = network.calls;
  network.bound.length = 0;
  await runAnalysis(runId);
  const run = await rowsOf(pool, "SELECT status, error_message AS errorMessage, started_at AS startedAt FROM analysis_runs WHERE id = ?", [runId]);
  const [bound] = network.bound as Array<Record<string, unknown>> | [undefined];
  mustBe(
    network.calls === callsBefore + 1 && bound?.organizationId === world.organizationId && bound?.baseUrl === MODEL.baseUrl && bound?.apiKey === PLAIN_KEY && bound?.model === MODEL.model,
    "run 干活的范围里绑定着的应当是工作区自己的地址、key 和模型名",
    { calls: network.calls - callsBefore, bound: network.bound },
  );
  mustBe(run[0]?.status === "failed" && run[0]?.startedAt !== null && String(run[0]?.errorMessage).includes(NO_NETWORK), "配了模型之后 run 应当被认领并走到取仓库那一步", run);
  mustBe(!String(run[0]?.errorMessage).includes(MODEL_NOT_CONFIGURED), "失败原因不是没配模型", run);

  // 同一个仓库、同一个扫描小时：配了模型之后扫描捞得到它（一路走到读仓库，那里故意停下）。第 2 步的「不碰它」确实是因为没配模型。
  await pool.execute("UPDATE repositories SET pending_push_count = 1 WHERE id = ?", [world.hostedRepositoryId]);
  const swept = await runAnalysisTriggerSweepOnce({
    queue: async () => {
      throw new Error("读仓库失败之后不应当走到入队");
    },
    getAdapter: () => {
      throw new Error(REACHED_REPOSITORY);
    },
  });
  mustBe(swept.analyzed === 0 && swept.deferredSkip === 1 && swept.noCommits === 0 && swept.errors.length === 1 && String(swept.errors[0]).includes(REACHED_REPOSITORY), "配了模型之后定时扫描应当捞到这个仓库", swept);
  mustBe(await pendingOf(pool, world.hostedRepositoryId) === 1, "读仓库失败时待处理的计数留着", await pendingOf(pool, world.hostedRepositoryId));
  await pool.execute("UPDATE repositories SET pending_push_count = 0 WHERE id = ?", [world.hostedRepositoryId]);

  await switchAnalysisExecutor(world.clientProductId, "server");
  const switched = await rowsOf(pool, "SELECT analysis_executor AS executor FROM products WHERE id = ?", [world.clientProductId]);
  mustBe(switched[0]?.executor === "server", "配了模型之后能把产品切成服务端分析", switched);
  return ["配了模型：入队过了闸门；webhook 走到入队并接受这次投递（重复投递不再入队）；run 被认领，干活的范围里绑定的是工作区自己的模型；定时扫描捞得到这个仓库；能切成服务端分析"];
}

/** 第 5 步：回执。出口在绑定了工作区模型时发出的调用，在真实的表里记下 model_source。 */
async function verifyReceipts(pool: Pool, world: World): Promise<string[]> {
  // 地址校验在解析域名之前就拒绝，所以这一次不会去连任何地方。
  await pool.execute("UPDATE organization_models SET base_url = 'http://127.0.0.1:4000/v1' WHERE organization_id = ?", [world.organizationId]);
  const error = await withOrganizationModel(world.organizationId, () =>
    requestStructuredCompletionDetailed([{ role: "user", content: "ping" }], { runId: world.queuedRun, accountId: null, chargeComponent: "main" }),
  ).then(
    () => null,
    (caught: unknown) => caught,
  );
  mustBe(error instanceof ModelUrlError && error.code === "not_https", "出口应当在地址校验处停下（不是去读服务器的 AI_MODEL、AI_API_KEY）", String(error));
  await pool.execute("UPDATE organization_models SET base_url = ? WHERE organization_id = ?", [MODEL.baseUrl, world.organizationId]);

  await recordLlmCallReceipt({ runId: world.queuedRun, accountId: null, chargeComponent: "main", model: "server-model", outcome: "failed", usageRaw: null });
  const receipts = await rowsOf(pool, "SELECT model, outcome, model_source AS modelSource FROM llm_call_receipts WHERE run_id = ? ORDER BY id", [world.queuedRun]);
  mustBe(
    JSON.stringify(receipts) === JSON.stringify([
      { model: "k3-256k", outcome: "failed", modelSource: "organization" },
      { model: "server-model", outcome: "failed", modelSource: null },
    ]),
    "工作区模型的回执记 model_source = organization，用的是工作区的模型名；CoDelphi 自己的留空",
    receipts,
  );
  return ["回执：工作区模型的调用在真实的 llm_call_receipts 里记 model_source = organization；CoDelphi 自己的照旧留空"];
}

/** 第 6 步：删除。 */
async function verifyDelete(pool: Pool, world: World): Promise<string[]> {
  const inUse = await deleteOrganizationModel(world.organizationId).then(
    () => null,
    (error: unknown) => error,
  );
  mustBe(inUse instanceof ModelInUseError && JSON.stringify(inUse.products) === JSON.stringify(["hosted", "client-product"]), "还有产品由服务端分析时不能删，并说出是哪些产品", String(inUse));
  mustBe((await storedRow(pool, world.organizationId)).organization_id === world.organizationId, "被拒的删除不能动这一行", await storedRow(pool, world.organizationId));

  await switchAnalysisExecutor(world.hostedProductId, "client");
  await switchAnalysisExecutor(world.clientProductId, "client");
  mustBe(await deleteOrganizationModel(world.organizationId), "产品都改成客户端分析之后能删", await storedRow(pool, world.organizationId));
  mustBe(Object.keys(await storedRow(pool, world.organizationId)).length === 0, "删了之后没有这一行", await storedRow(pool, world.organizationId));
  mustBe(await deleteOrganizationModel(world.organizationId) === false, "再删一次什么也没删", await storedRow(pool, world.organizationId));

  await saveOrganizationModel(via(pool), { ...MODEL, organizationId: world.bareOrganizationId });
  await pool.execute("DELETE FROM organizations WHERE id = ?", [world.bareOrganizationId]);
  mustBe(Object.keys(await storedRow(pool, world.bareOrganizationId)).length === 0, "删工作区时它的模型配置跟着删", await storedRow(pool, world.bareOrganizationId));
  return ["删除：还有产品由服务端分析时被拒并说出是哪些；都改成客户端分析后能删；删工作区时级联"];
}

async function main(): Promise<void> {
  const url = process.env[ENV_URL];
  if (!url) throw new Error(`缺少 ${ENV_URL}：这个脚本只认它，不读 DATABASE_URL（它会删库重建，不能指向别的库）`);
  // 演练自己生成主密钥，不用开发机上的。服务器的模型配置从环境里拿掉：哪一步去读了 AI_MODEL、AI_API_KEY，就会在那里报出来。
  process.env.SESSION_SECRET = randomBytes(32).toString("hex");
  for (const name of ["AI_MODEL", "AI_API_KEY", "AI_BASE_URL"]) delete process.env[name];
  // 一个假的 GitHub token：有了它，run 才能走到第一次 GitHub 请求，fetch 的替身在那里接住（不发任何请求）。
  process.env.GITHUB_TOKEN = "rehearsal-token-not-real";
  globalThis.fetch = (async () => {
    network.calls += 1;
    network.bound.push(currentOrganizationModel());
    throw new Error(NO_NETWORK);
  }) as typeof fetch;
  await withScratchDatabase({ url, prefix: SCRATCH_PREFIX, envName: ENV_URL }, async (pool, info) => {
    const world = await seed(pool);
    console.log(`临时库 ${info.database}，服务器 MySQL ${info.serverVersion}，${info.migrations} 个迁移文件。`);
    for (const line of [
      ...(await verifySchema(pool)),
      ...(await verifyNothingWithoutModel(pool, world)),
      ...(await verifySave(pool, world)),
      ...(await verifyConfigured(pool, world)),
      ...(await verifyReceipts(pool, world)),
      ...(await verifyDelete(pool, world)),
    ]) console.log(`  ${line}`);
  });
  console.log("全部通过");
}

if (process.argv[1]?.endsWith("verify-organization-model-mysql.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
