/**
 * 客户端提案发布在真实 MySQL 上的演练（修订稿 §8 第 1 期的几项验收，都用生产会用的入口）：
 *
 *   1. 确定性合并逐项相同：同一份分析结果，一份经提案入口发给「客户端分析」的产品，一份经托管入口（saveResult，
 *      带补丁）发给「托管」的产品。首版和带变更窗口的第二版各比一次，规格版本、功能、场景、变化、发布、
 *      发布文件、文件索引、工作台逐表比较，除了编号和时间戳必须完全相同。
 *   2. 回执：run 行是 client_upload、提交就是 succeeded、带幂等键和提案哈希；版本带两组来源信息；
 *      流程图按合并后的场景校验后存下；理解层候选落成 client_generated。
 *   3. 幂等：同一份提案换一个幂等键重传是重放，回执指向原来的版本，不产生新版本。
 *   4. 基线过期：基于旧版本的提案被拒绝，回执里有当前版本和判定；什么都没写；拒绝审计里有一行。
 *   5. 并发：两个发布基于同一个版本同时提交，只能一个成功，另一个得到 base_changed，版本只多一个。
 *   6. 仓库身份：产品不是客户端分析、产品不存在、增量提案、仓库没绑定、身份对不上、仓库已被别的产品占用、
 *      首次发布建立绑定（远端和纯本地各一次）。
 *   7. 零网络调用：整个演练期间把 fetch 换成一调用就记账并抛错的函数，每次发布之后断言账本是空的。
 *      服务端发模型请求和拉源码都走 fetch。
 *
 * 只接受库名以 codelphi_test_client_publish 开头的库，每次运行都先删掉重建；绝不读 DATABASE_URL。
 *
 * 用法（在仓库根目录）：
 *   CLIENT_PUBLISH_VERIFY_DATABASE_URL="mysql://user:pass@127.0.0.1:3306/codelphi_test_client_publish" \
 *     npx tsx scripts/verify-client-publish-mysql.ts
 */
import type { Pool } from "mysql2/promise";
import { saveResult, type RunContext } from "../lib/analysis";
import type { AnalysisResult } from "../lib/ai";
import { sealProposal, type Proposal } from "../lib/client-proposal/contract";
import { ProposalRejection, loadPublishTarget, publishProposal, recordProposalRejection, type PublishReceipt, type PublishTarget } from "../lib/client-proposal/publish";
import { insertIdOf, withScratchDatabase } from "./scratch-database";

const SCRATCH_PREFIX = "codelphi_test_client_publish";
const ENV_URL = "CLIENT_PUBLISH_VERIFY_DATABASE_URL";

type Row = Record<string, unknown>;

function mustBe(ok: boolean, message: string, details: unknown): void {
  if (!ok) throw new Error(`${message}；实际是 ${JSON.stringify(details).slice(0, 2_000)}`);
}

function rowsOf(result: unknown): Row[] {
  const payload = Array.isArray(result) ? result[0] : result;
  return (Array.isArray(payload) ? payload : []) as Row[];
}

async function query(pool: Pool, statement: string, parameters: Array<string | number | null> = []): Promise<Row[]> {
  return rowsOf(await pool.execute(statement, parameters));
}

const scenarioOf = (reference: string, path: string, startLine: number, outcome: string) => ({
  reference,
  context: "用户使用产品",
  action: `做 ${reference} 对应的事`,
  outcome,
  category: "happy" as const,
  evidence: [{ path, startLine }],
});

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
    // HP-1 的锚点（第 10 行）落进了改动区间：重新提取，措辞变了。EC-1（第 20 行）没被碰到，这次没提取出来，靠沿用回来。
    { name: "Login", summary: "Login handles sign-in.", scenarios: [scenarioOf("HP-1", "lib/auth.ts", 11, "进入首页，重试次数增加")] },
    { name: "Exports", summary: "Exports data.", scenarios: [scenarioOf("HP-1", "lib/export.ts", 3, "导出成功")] },
  ],
};

/** 托管入口看到的补丁。行为判定和行号区间都从它算，结果必须和客户端交上来的窗口一样。 */
const AUTH_CODE_PATCH = "@@ -10,3 +12,4 @@\n-const attempts = 1;\n+const attempts = 2;\n+const delay = 10;\n const retry = true;\n";
const DOC_COMMENT_PATCH = "@@ -1,2 +1,2 @@\n-# 旧标题\n+# 新标题\n\n正文\n";
const hostedChange = (sha: string) => ({
  message: `release ${sha}`,
  committedAt: "2026-11-01T00:00:00.000Z",
  url: `https://github.com/acme/api-client/commit/${sha}`,
  files: [
    { path: "lib/auth.ts", status: "modified", patch: AUTH_CODE_PATCH },
    { path: "README.md", status: "modified", patch: DOC_COMMENT_PATCH },
  ],
});

/** 客户端在本地从同一批补丁算出来的窗口：没有补丁文本，只有路径、状态、行为标志和行号区间。 */
const clientWindow = {
  files: [
    { path: "lib/auth.ts", previousPath: null, status: "modified" as const, behavioral: true, hunks: [{ oldStart: 10, oldCount: 3, newStart: 12, newCount: 4 }] },
    { path: "README.md", previousPath: null, status: "modified" as const, behavioral: false, hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 }] },
  ],
  analyzedPaths: ["lib/auth.ts"],
  skipped: [{ path: "README.md", reason: "documentation" }],
  affectedFeatureKeys: ["login"],
};

const coverage = { implFilesAssembled: 2, implFilesTotal: 3, implBytesAssembled: 200, implBytesTotal: 300, partitionsUsed: 1, partitionsCapped: false, diffTotalPaths: null, diffSelectedPaths: null, diffOmittedPaths: null, primaryRangesOmitted: null };

const loginFlow = {
  featureStableKey: "login",
  fingerprint: "whatever the client computed",
  graph: {
    entryNodeIds: ["start"],
    nodes: [
      { id: "start", kind: "start", title: "开始", scenarioRefs: [] },
      { id: "sign-in", kind: "action", title: "登录", scenarioRefs: ["HP-1"] },
      { id: "retry", kind: "action", title: "密码错误", scenarioRefs: ["EC-1"] },
    ],
    edges: [
      { id: "e1", from: "start", to: "sign-in", kind: "sequence", scenarioRefs: ["HP-1"] },
      { id: "e2", from: "sign-in", to: "retry", kind: "sequence", scenarioRefs: ["EC-1"] },
    ],
    excludedScenarios: [],
  },
};

const presentation = {
  tagline: "一句话说明产品",
  coreCapabilities: [{ name: "登录", summary: "登录相关", featureNames: ["Login"], scenarioRefs: [] }],
  journeys: [{ name: "登录", steps: [{ featureName: "Login", reference: "HP-1" }] }],
};

function proposalOf(input: { idempotencyKey: string; repository: Record<string, unknown>; sha: string; title: string; base: { specVersionId: number; sha: string } | null; publication: AnalysisResult; withWindow: boolean }): Proposal {
  return sealProposal({
    contractVersion: "2.0.0",
    artifactKind: "codelphi-analysis-proposal",
    idempotencyKey: input.idempotencyKey,
    mode: "full",
    language: "zh-CN",
    repository: input.repository,
    revision: { sha: input.sha, treeSha: null, committedAt: "2026-11-01T00:00:00.000Z", title: input.title, branch: "main" },
    base: input.base,
    window: input.withWindow ? clientWindow : null,
    proposal: input.publication,
    carryClaims: [],
    coverage,
    flows: input.withWindow ? [loginFlow] : [],
    presentation,
    client: { version: "0.1.0", pipelineVersion: "p1", promptVersion: "2026-11-27", model: "tenant-model", impactRulesVersion: "impact-v1", analyzedAt: "2026-11-27T01:00:00.000Z" },
  });
}

const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const SHA3 = "3".repeat(40);
let keyCounter = 0;
const nextKey = () => {
  keyCounter += 1;
  return `00000000-0000-4000-8000-${String(keyCounter).padStart(12, "0")}`;
};

/** 编号、时间戳、run 的来源这类两边天生不同的列，比的时候去掉。 */
const VOLATILE = /^(id|.*_id|.*Id|.*_at|.*At|trigger_type|client_idempotency_key|client_proposal_hash|provenance_json|error_message|active_slot|account_id|billing_reservation_attempt|last_error_code|last_error_at)$/;

/** JSON 列里也会嵌着编号（变化记录的 before/after 里带着工作台功能的 id），一样去掉。 */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const kept: Row = {};
    for (const [key, item] of Object.entries(value as Row)) if (!VOLATILE.test(key)) kept[key] = scrub(item);
    return kept;
  }
  return typeof value === "bigint" ? Number(value) : Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

async function tableOf(pool: Pool, table: string, where: string, parameters: Array<string | number | null>): Promise<string[]> {
  return (await query(pool, `SELECT * FROM ${table} WHERE ${where}`, parameters)).map((row) => JSON.stringify(scrub(row))).sort();
}

interface Product {
  target: PublishTarget;
  repositoryId: number;
  slug: string;
}

async function seedProduct(pool: Pool, organizationId: number, slug: string, executor: "server" | "client"): Promise<Product> {
  const productId = insertIdOf(await pool.execute("INSERT INTO products (organization_id, slug, name, description, analysis_executor) VALUES (?, ?, ?, ?, ?)", [organizationId, slug, slug, "", executor]));
  return { target: { productId, organizationId, productSlug: slug, productName: slug }, repositoryId: 0, slug };
}

async function seedManualRows(pool: Pool, productId: number): Promise<void> {
  const manual = insertIdOf(await pool.execute("INSERT INTO features (product_id, name, summary, source, active) VALUES (?, ?, ?, 'manual', 1)", [productId, "Manual notes", "人工维护的说明"]));
  const retired = insertIdOf(await pool.execute("INSERT INTO features (product_id, name, summary, source, active) VALUES (?, ?, ?, 'manual', 0)", [productId, "Legacy export", "被人工下线的导出"]));
  await pool.execute("INSERT INTO scenarios (feature_id, reference, context, action, outcome, category, source, evidence) VALUES (?, 'HP-1', '人工', '查看说明', '看到人工说明', 'happy', 'manual', '[]')", [manual]);
  await pool.execute("INSERT INTO scenarios (feature_id, reference, context, action, outcome, category, source, active, evidence) VALUES (?, 'EC-1', '人工', '旧导出', '旧的导出结果', 'edge', 'manual', 0, '[]')", [retired]);
}

/** 托管入口：插一个 run，走 saveResult（它自己开事务）。 */
async function hostedPublish(pool: Pool, product: Product, sha: string, publication: AnalysisResult, withWindow: boolean, base: { specVersionId: number } | null): Promise<{ specVersionId: number; releaseId: number }> {
  const runId = insertIdOf(await pool.execute("INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status) VALUES (?, 'manual', NULL, ?, 'running')", [product.repositoryId, sha]));
  const run: RunContext = {
    id: runId,
    repositoryId: product.repositoryId,
    productId: product.target.productId,
    owner: "acme",
    name: "api",
    beforeSha: null,
    afterSha: sha,
    ...(base ? { baseSpecVersionId: base.specVersionId, baseCapturedAt: new Date("2026-11-02T00:00:00.000Z") } : {}),
    connectionId: null,
    provider: "github",
    organizationId: product.target.organizationId,
    productSlug: product.slug,
    productName: product.slug,
  };
  const hosted = hostedChange(sha);
  // 发布链接两边给成同一个值：托管路径平时拿的是代码托管服务的地址，这里只为了让除编号外的每一列都能比。
  const change = { ...hosted, files: withWindow ? hosted.files : [] };
  const saved = await saveResult(run, publication, change, null, { ...coverage, coverageRatio: coverage.implBytesAssembled / coverage.implBytesTotal });
  return { specVersionId: saved.specVersionId, releaseId: saved.releaseId };
}

/**
 * 逐表比较两个产品的同一版。两边除了编号、时间戳和 run 的来源，必须完全相同。
 * 流程图不在这里比：托管路径的图是模型在分析流程里生成的，不在合并入口里，没法逐字节比；
 * 客户端的图另有断言（按合并后的场景校验后才存、指纹由服务端算）。
 */
async function compareVersions(pool: Pool, client: Product, hosted: Product, clientVersion: number, hostedVersion: number, label: string): Promise<void> {
  const pairs: Array<[string, string, Array<string | number | null>, string, Array<string | number | null>]> = [
    ["spec_versions", "id = ?", [clientVersion], "id = ?", [hostedVersion]],
    ["spec_features", "spec_version_id = ?", [clientVersion], "spec_version_id = ?", [hostedVersion]],
    ["spec_scenarios", "spec_feature_id IN (SELECT id FROM spec_features WHERE spec_version_id = ?)", [clientVersion], "spec_feature_id IN (SELECT id FROM spec_features WHERE spec_version_id = ?)", [hostedVersion]],
    ["spec_changes", "spec_version_id = ?", [clientVersion], "spec_version_id = ?", [hostedVersion]],
    ["spec_file_index", "spec_version_id = ?", [clientVersion], "spec_version_id = ?", [hostedVersion]],
    ["releases", "analysis_run_id IN (SELECT id FROM analysis_runs WHERE after_sha = (SELECT sha FROM spec_versions WHERE id = ?))", [clientVersion], "analysis_run_id IN (SELECT id FROM analysis_runs WHERE after_sha = (SELECT sha FROM spec_versions WHERE id = ?))", [hostedVersion]],
    ["release_files", "release_id IN (SELECT id FROM releases WHERE analysis_run_id IN (SELECT id FROM analysis_runs WHERE after_sha = (SELECT sha FROM spec_versions WHERE id = ?)))", [clientVersion], "release_id IN (SELECT id FROM releases WHERE analysis_run_id IN (SELECT id FROM analysis_runs WHERE after_sha = (SELECT sha FROM spec_versions WHERE id = ?)))", [hostedVersion]],
    ["features", "product_id = ?", [client.target.productId], "product_id = ?", [hosted.target.productId]],
    ["scenarios", "feature_id IN (SELECT id FROM features WHERE product_id = ?)", [client.target.productId], "feature_id IN (SELECT id FROM features WHERE product_id = ?)", [hosted.target.productId]],
  ];
  for (const [table, whereLeft, parametersLeft, whereRight, parametersRight] of pairs) {
    const left = await tableOf(pool, table, whereLeft, parametersLeft);
    const right = await tableOf(pool, table, whereRight, parametersRight);
    mustBe(left.length > 0 || right.length === 0, `${label}：${table} 不该是空的`, { left: left.length });
    if (left.join("\n") !== right.join("\n")) {
      const index = left.findIndex((row, position) => row !== right[position]);
      throw new Error(`${label}：${table} 两边不同（提案入口 ${left.length} 行，托管入口 ${right.length} 行）。第一处不同：\n  提案入口：${(left[index] ?? "（没有）").slice(0, 700)}\n  托管入口：${(right[index] ?? "（没有）").slice(0, 700)}`);
    }
  }
}

async function main(): Promise<void> {
  const url = process.env[ENV_URL];
  if (!url) throw new Error(`缺少 ${ENV_URL}：这个脚本只认它，不读 DATABASE_URL（它会删库重建，不能指向别的库）`);
  await withScratchDatabase({ url, prefix: SCRATCH_PREFIX, envName: ENV_URL }, async (pool, info) => {
    console.log(`临时库 ${info.database}，服务器 MySQL ${info.serverVersion}，${info.migrations} 个迁移文件。`);
    const networkCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      networkCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      throw new Error("network call during a client publish");
    }) as typeof fetch;
    const noNetwork = (label: string) => mustBe(networkCalls.length === 0, `${label}：发布期间不该有任何网络调用`, networkCalls);

    try {
      const organizationId = insertIdOf(await pool.execute("INSERT INTO organizations (slug, name) VALUES (?, ?)", ["publish-org", "Publish Org"]));
      const client = await seedProduct(pool, organizationId, "client-product", "client");
      const hosted = await seedProduct(pool, organizationId, "hosted-product", "server");
      hosted.repositoryId = insertIdOf(await pool.execute("INSERT INTO repositories (product_id, provider, owner, name, default_branch, host) VALUES (?, 'github', 'acme', 'api', 'main', 'github.com')", [hosted.target.productId]));
      // 客户端产品和托管产品是两个不同的仓库：同一个仓库不能绑到两个产品上。
      const github = { provider: "github", host: "github.com", owner: "acme", name: "api-client" };

      // ── 1. 首版：确定性合并逐项相同 ───────────────────────────────────────────
      const first = await publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: null, ...github }, sha: SHA1, title: "release 1", base: null, publication: firstPublication, withWindow: false }), client.target);
      noNetwork("首版");
      client.repositoryId = first.repositoryId;
      const hostedFirst = await hostedPublish(pool, hosted, SHA1, firstPublication, false, null);
      await compareVersions(pool, client, hosted, first.specVersionId, hostedFirst.specVersionId, "首版");
      const firstRun = (await query(pool, "SELECT trigger_type AS triggerType, status, client_idempotency_key AS idempotencyKey, client_proposal_hash AS proposalHash FROM analysis_runs WHERE repository_id = ?", [client.repositoryId]))[0];
      mustBe(firstRun?.triggerType === "client_upload" && firstRun.status === "succeeded" && typeof firstRun.idempotencyKey === "string" && String(firstRun.proposalHash).length === 64, "首版：run 行是 client_upload、提交即 succeeded、带幂等键和提案哈希", firstRun);
      const binding = (await query(pool, "SELECT product_id AS productId, provider, host, owner, name FROM repositories WHERE id = ?", [client.repositoryId]))[0];
      mustBe(Number(binding?.productId) === client.target.productId && binding?.host === "github.com" && binding?.owner === "acme", "首版：首次发布建立了仓库绑定并记下主机名", binding);
      console.log("  首版：提案入口和托管入口逐表相同；首次发布建立了绑定");

      // ── 2. 第二版（带变更窗口）：逐项相同，回执和落库的东西都在 ─────────────
      await seedManualRows(pool, client.target.productId);
      await seedManualRows(pool, hosted.target.productId);
      const secondProposal = proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: client.repositoryId, ...github }, sha: SHA2, title: "release 2", base: { specVersionId: first.specVersionId, sha: SHA1 }, publication: secondPublication, withWindow: true });
      const second = await publishProposal(pool, secondProposal, client.target);
      noNetwork("第二版");
      const hostedSecond = await hostedPublish(pool, hosted, SHA2, secondPublication, true, { specVersionId: hostedFirst.specVersionId });
      await compareVersions(pool, client, hosted, second.specVersionId, hostedSecond.specVersionId, "第二版");
      const carried = await query(pool, "SELECT s.reference FROM spec_scenarios s JOIN spec_features f ON f.id = s.spec_feature_id WHERE f.spec_version_id = ? AND f.name = 'Login' ORDER BY s.reference", [second.specVersionId]);
      mustBe(carried.length === 2, "第二版：Login 有重新提取的 HP-1 和沿用回来的 EC-1", carried);
      mustBe(second.replayed === false && second.verification.reanalyzed === secondPublication.features.length && second.verification.deterministicallyCarried >= 1, "第二版：回执里三类功能的计数", second);
      const provenance = (await query(pool, "SELECT provenance_json AS provenance FROM spec_versions WHERE id = ?", [second.specVersionId]))[0]?.provenance;
      const parsed = typeof provenance === "string" ? JSON.parse(provenance) : provenance;
      mustBe(parsed?.server?.executor === "client" && parsed?.server?.specVersionId === second.specVersionId && parsed?.client?.model === "tenant-model" && parsed?.client?.analyzedAt === "2026-11-27T01:00:00.000Z", "第二版：版本带两组来源信息", parsed);
      mustBe((await query(pool, "SELECT provenance_json AS provenance FROM spec_versions WHERE id = ?", [hostedSecond.specVersionId]))[0]?.provenance == null, "第二版：托管的版本不写来源信息", null);
      const flow = (await query(pool, "SELECT graph_json AS graph FROM spec_feature_flows WHERE spec_feature_id IN (SELECT id FROM spec_features WHERE spec_version_id = ? AND stable_key = 'login')", [second.specVersionId]))[0];
      mustBe(flow !== undefined && JSON.stringify(flow.graph).includes("sign-in"), "第二版：客户端的流程图校验通过后存下了", flow);
      const shown = (await query(pool, "SELECT source, spec_version_id AS specVersionId FROM product_presentations WHERE product_id = ?", [client.target.productId]))[0];
      mustBe(shown?.source === "client_generated" && Number(shown.specVersionId) === second.specVersionId, "第二版：理解层候选落成 client_generated，跟随版本", shown);
      console.log("  第二版：带变更窗口的提案和带补丁的托管入口逐表相同；来源信息、流程图、理解层都落了");

      // ── 3. 幂等 ──────────────────────────────────────────────────────────────
      const versionCount = Number((await query(pool, "SELECT COUNT(*) AS count FROM spec_versions WHERE repository_id = ?", [client.repositoryId]))[0]?.count);
      const replayed = await publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: client.repositoryId, ...github }, sha: SHA2, title: "release 2", base: { specVersionId: first.specVersionId, sha: SHA1 }, publication: secondPublication, withWindow: true }), client.target);
      mustBe(replayed.replayed === true && replayed.specVersionId === second.specVersionId && replayed.releaseId === second.releaseId, "幂等：同一份提案换一个幂等键重传是重放", replayed);
      mustBe(Number((await query(pool, "SELECT COUNT(*) AS count FROM spec_versions WHERE repository_id = ?", [client.repositoryId]))[0]?.count) === versionCount, "幂等：重放不产生新版本", null);
      const again = await publishProposal(pool, secondProposal, client.target);
      mustBe(again.replayed === true && again.specVersionId === second.specVersionId, "幂等：同一个幂等键重传也是重放", again);
      console.log("  幂等：换幂等键重传、原样重传都是重放，不产生新版本");

      // ── 4. 基线过期 ───────────────────────────────────────────────────────────
      const stale = proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: client.repositoryId, ...github }, sha: SHA3, title: "release 3", base: { specVersionId: first.specVersionId, sha: SHA1 }, publication: secondPublication, withWindow: true });
      const staleError = await publishProposal(pool, stale, client.target).then(
        () => null,
        (error: unknown) => error,
      );
      mustBe(staleError instanceof ProposalRejection && staleError.code === "base_changed", "基线过期：基于旧版本的提案被拒绝", String(staleError));
      const details = (staleError as ProposalRejection).details as { current: { specVersionId: number }; verdict: string };
      mustBe(details.current.specVersionId === second.specVersionId && details.verdict === "reanalyze", "基线过期：回执指出当前版本，并判定要重新分析", details);
      mustBe(Number((await query(pool, "SELECT COUNT(*) AS count FROM analysis_runs WHERE repository_id = ? AND after_sha = ?", [client.repositoryId, SHA3]))[0]?.count) === 0, "基线过期：什么都没写，连 run 行也没有", null);
      await recordProposalRejection(pool, { organizationId, productId: client.target.productId, repositoryId: client.repositoryId, revisionSha: SHA3, proposalHash: stale.proposalHash, code: "base_changed", details });
      const audit = (await query(pool, "SELECT revision_sha AS revisionSha, proposal_hash AS proposalHash, error_code AS errorCode FROM client_proposal_rejections WHERE product_id = ?", [client.target.productId]))[0];
      mustBe(audit?.errorCode === "base_changed" && audit.revisionSha === SHA3.slice(0, 12) && audit.proposalHash === stale.proposalHash.slice(7), "基线过期：拒绝审计里有一行，只记机器可读的东西", audit);
      console.log("  基线过期：被拒绝、回执带当前版本和判定、什么都没写、审计有一行");

      // ── 5. 并发 ──────────────────────────────────────────────────────────────
      const thirdPublication: AnalysisResult = { ...secondPublication, release: { title: "Third release", summary: "Third summary" } };
      const left = proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: client.repositoryId, ...github }, sha: `4${"a".repeat(39)}`, title: "release 4", base: { specVersionId: second.specVersionId, sha: SHA2 }, publication: thirdPublication, withWindow: false });
      const right = proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: client.repositoryId, ...github }, sha: `5${"b".repeat(39)}`, title: "release 5", base: { specVersionId: second.specVersionId, sha: SHA2 }, publication: thirdPublication, withWindow: false });
      const before = Number((await query(pool, "SELECT COUNT(*) AS count FROM spec_versions WHERE repository_id = ?", [client.repositoryId]))[0]?.count);
      const race = await Promise.all([left, right].map((proposal) => publishProposal(pool, proposal, client.target).then(
        (receipt: PublishReceipt) => ({ ok: true as const, receipt }),
        (error: unknown) => ({ ok: false as const, error }),
      )));
      const winners = race.filter((entry) => entry.ok);
      const losers = race.filter((entry) => !entry.ok);
      mustBe(winners.length === 1 && losers.length === 1 && losers[0] && !(losers[0] as { ok: false; error: unknown }).ok && ((losers[0] as { ok: false; error: unknown }).error as ProposalRejection).code === "base_changed", "并发：两个发布基于同一版本，只能一个成功，另一个 base_changed", race.map((entry) => (entry.ok ? entry.receipt : String((entry as { error: unknown }).error))));
      const loser = losers[0] as { ok: false; error: ProposalRejection };
      mustBe(((loser.error.details as { current: { specVersionId: number } }).current).specVersionId === (winners[0] as { ok: true; receipt: PublishReceipt }).receipt.specVersionId, "并发：后到的那个在回执里看到的是先到的写入的版本", loser.error.details);
      mustBe(Number((await query(pool, "SELECT COUNT(*) AS count FROM spec_versions WHERE repository_id = ?", [client.repositoryId]))[0]?.count) === before + 1, "并发：版本只多了一个", null);
      mustBe(Number((await query(pool, "SELECT COUNT(*) AS count FROM analysis_runs WHERE repository_id = ? AND status = 'running'", [client.repositoryId]))[0]?.count) === 0, "并发：没有留下 running 的 run", null);
      noNetwork("并发");
      console.log("  并发：两个发布只能一个成功，另一个 base_changed，版本只多一个");

      // ── 6. 仓库身份 ───────────────────────────────────────────────────────────
      await expectRejection(() => loadPublishTarget(pool, "hosted-product", organizationId), "analysis_mode_is_server", "产品是托管的");
      await expectRejection(() => loadPublishTarget(pool, "missing-product", organizationId), "product_not_found", "产品不存在");
      await expectRejection(() => publishProposal(pool, { ...thirdPublication, mode: "incremental" } as unknown as Proposal, client.target), "incremental_not_supported", "增量提案");
      await expectRejection(() => publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: hosted.repositoryId, ...github }, sha: `6${"c".repeat(39)}`, title: "release 6", base: null, publication: firstPublication, withWindow: false }), client.target), "repository_not_bound", "仓库属于别的产品");
      await expectRejection(() => publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: client.repositoryId, ...github, owner: "someone-else" }, sha: `6${"c".repeat(39)}`, title: "release 6", base: { specVersionId: second.specVersionId, sha: SHA2 }, publication: firstPublication, withWindow: false }), client.target), "repository_mismatch", "仓库属主对不上");
      const other = await seedProduct(pool, organizationId, "other-client-product", "client");
      await expectRejection(() => publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: null, ...github }, sha: `6${"c".repeat(39)}`, title: "release 6", base: null, publication: firstPublication, withWindow: false }), other.target), "repository_already_bound", "仓库已被别的产品占用");
      const fresh = await seedProduct(pool, organizationId, "fresh-client-product", "client");
      const selfHosted = { provider: "gitlab", host: "gitlab.corp.com", owner: "team", name: "api" };
      const freshFirst = await publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: null, ...selfHosted }, sha: SHA1, title: "release 1", base: null, publication: firstPublication, withWindow: false }), fresh.target);
      const freshSecond = await publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: freshFirst.repositoryId, ...selfHosted }, sha: SHA2, title: "release 2", base: { specVersionId: freshFirst.specVersionId, sha: SHA1 }, publication: secondPublication, withWindow: false }), fresh.target);
      mustBe(freshSecond.replayed === false && freshSecond.specVersionId !== freshFirst.specVersionId, "仓库身份：首次发布建立绑定，第二次带着仓库 id 接着发", freshSecond);
      // 同一个 provider/owner/name 换一个主机名，是另一个仓库：带仓库 id 和首次发布两种来法都拒绝，不会并成一个仓库。
      await expectRejection(() => publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: freshFirst.repositoryId, ...selfHosted, host: "gitlab.other.com" }, sha: SHA3, title: "release 3", base: { specVersionId: freshSecond.specVersionId, sha: SHA2 }, publication: firstPublication, withWindow: false }), fresh.target), "repository_identity_conflict", "带仓库 id 但主机名不同");
      const otherHostProduct = await seedProduct(pool, organizationId, "other-host-product", "client");
      await expectRejection(() => publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: null, ...selfHosted, host: "gitlab.other.com" }, sha: SHA1, title: "release 1", base: null, publication: firstPublication, withWindow: false }), otherHostProduct.target), "repository_identity_conflict", "首次发布，同名仓库登记在别的主机上");
      mustBe(Number((await query(pool, "SELECT COUNT(*) AS count FROM repositories WHERE host = 'gitlab.other.com'"))[0]?.count) === 0 && Number((await query(pool, "SELECT COUNT(*) AS count FROM spec_versions WHERE repository_id = ?", [freshFirst.repositoryId]))[0]?.count) === 2, "仓库身份：主机名冲突不会建出第二条仓库记录，也不会多出版本", null);
      const localProduct = await seedProduct(pool, organizationId, "local-client-product", "client");
      const localFirst = await publishProposal(pool, proposalOf({ idempotencyKey: nextKey(), repository: { repositoryId: null, provider: "local", host: null, owner: null, name: "repo" }, sha: SHA1, title: "release 1", base: null, publication: firstPublication, withWindow: false }), localProduct.target);
      const localRow = (await query(pool, "SELECT provider, host FROM repositories WHERE id = ?", [localFirst.repositoryId]))[0];
      mustBe(localRow?.provider === "local" && localRow.host === null, "仓库身份：纯本地仓库按产品绑定，没有主机名", localRow);
      console.log("  仓库身份：托管产品、不存在、增量、没绑定、属主不符、已被占用各自被拒；远端和纯本地的首次发布建立了绑定");

      noNetwork("仓库身份");
      mustBe(networkCalls.length === 0, "整个演练期间不该有任何网络调用", networkCalls);
      console.log("  零网络调用：整个演练期间模型和源码接口一次都没被调用");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  console.log("全部通过");
}

async function expectRejection(run: () => Promise<unknown>, code: string, label: string): Promise<void> {
  const error = await run().then(
    () => null,
    (caught: unknown) => caught,
  );
  mustBe(error instanceof ProposalRejection && error.code === code, `${label}：应当被拒绝（${code}）`, String(error));
}

if (process.argv[1]?.endsWith("verify-client-publish-mysql.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
