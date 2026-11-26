/**
 * 导入草稿回填在真实 MySQL 上的演练。每一步都走生产会用的入口：导入走 importSnapshotArtifact，
 * 回填走 backfillImportDraft（和命令同一个函数）。全程把 fetch 换成一调用就记账并抛错的函数。
 *
 *   1. 真实导入一份雷达快照：产品、仓库行、草稿行、简介都是导入自己写的。再照工作台编辑服务的做法
 *      改一条场景（来源变 manual）、删一条（停用，来源变 manual）。
 *   2. 演练：事务里真做一遍再回滚。报告里给出会写出什么；之后逐表核对库里一个字节都没变。
 *   3. 写入：逐项核对 run、版本、发布、来源信息、工作台、文件索引、变化和回归任务；
 *      草稿的每一条场景在版本里都能找到，文字和锚点逐字相同；人工改的那条按人工内容进版本，删掉的那条不回来；
 *      工作台行的编号不变，来源改成 generated，身份补上；简介原样保留。
 *   4. 重跑：已经有版本，拒绝，什么都没写。
 *   5. 去重：另一份草稿里有两条完全一样的场景。演练报告点出这一条；写入被拒绝、库里没变；
 *      明确接受后写入，那条重复的行从工作台上停用。
 *   6. 不满足条件：工作区不干净的快照、已经有版本的仓库，都拒绝且不写。
 *   7. 隔离：把回填的 run 改回排队再交给 runAnalysis，它被标失败，原因写明这是回执；服务端不执行它。
 *
 * 只接受库名以 codelphi_test_import_backfill 开头的库，每次运行都先删掉重建；绝不读 DATABASE_URL。
 *
 * 用法（在仓库根目录）：
 *   IMPORT_BACKFILL_VERIFY_DATABASE_URL="mysql://user:pass@127.0.0.1:3306/codelphi_test_import_backfill" \
 *     npx tsx scripts/verify-import-backfill-mysql.ts
 */
import type { Pool } from "mysql2/promise";
import { runAnalysis } from "../lib/analysis";
import { IMPORT_BACKFILL_TRIGGER } from "../lib/analysis-executor";
import { backfillImportDraft, blockagesOf, ImportBackfillRefused, loadBackfillCandidate, type ImportBackfillReceipt } from "../lib/import-draft-backfill";
import { CONTRACT_VERSION } from "../lib/extraction-contract";
import { clientProvenanceOf } from "../lib/version-provenance";
import { importSnapshotArtifact } from "../lib/snapshot-import";
import { insertIdOf, withScratchDatabase } from "./scratch-database";

const SCRATCH_PREFIX = "codelphi_test_import_backfill";
const ENV_URL = "IMPORT_BACKFILL_VERIFY_DATABASE_URL";
const COMMITTED_AT = "2026-11-18T09:30:00.000Z";

type Row = Record<string, unknown>;

function mustBe(ok: boolean, message: string, details: unknown = null): asserts ok {
  if (!ok) throw new Error(`${message}；实际是 ${JSON.stringify(details, (_key, value: unknown) => (typeof value === "bigint" ? Number(value) : value)).slice(0, 2_000)}`);
}

function rowsOf(result: unknown): Row[] {
  const payload = Array.isArray(result) ? result[0] : result;
  return (Array.isArray(payload) ? payload : []) as Row[];
}

async function query(pool: Pool, statement: string, parameters: Array<string | number | null> = []): Promise<Row[]> {
  return rowsOf(await pool.execute(statement, parameters));
}

const scenario = (reference: string, path: string, startLine: number, outcome: string, extra: Partial<{ endLine: number; step: number }> = {}) => ({
  reference,
  context: `使用 ${path} 的用户`,
  action: `执行 ${reference} 对应的操作`,
  outcome,
  category: "happy" as const,
  ...extra,
  evidence: [{ path, startLine, ...(extra.endLine ? { endLine: extra.endLine } : {}) }],
});

const snapshot = (name: string, revision: string, dirty = false) => ({
  artifactKind: "codelphi-radar-snapshot",
  exportVersion: 1,
  contractVersion: CONTRACT_VERSION,
  identity: { name, revision, treeSha: [...revision].map((digit) => ((parseInt(digit, 16) + 1) % 16).toString(16)).join(""), originRemote: `https://github.com/acme/${name}`, workingTreeDirty: dirty, branch: "main" },
  language: "zh-CN",
  product: { description: `${name} 的简介，随快照导入`, evidence: [{ path: "README.md", startLine: 1 }] },
  features: [
    { name: "登录", summary: "登录功能", scenarios: [scenario("HP-1", "lib/login.ts", 10, "进入首页", { step: 1 }), scenario("EC-1", "lib/login.ts", 20, "提示密码错误"), scenario("ER-1", "lib/login.ts", 30, "锁定账号")] },
    { name: "导出", summary: "", scenarios: [scenario("HP-1", "lib/export.ts", 5, "拿到文件", { step: 1, endLine: 9 }), { reference: "EC-1", context: "没有证据的场景", action: "导出", outcome: "原样带着", category: "edge" as const, evidence: [] }] },
  ],
});

/** 和另一条文字、证据路径都完全一样的两条场景：合并入口会去掉后一条。 */
const withDuplicates = (name: string, revision: string, dirty = false) => {
  const base = snapshot(name, revision, dirty);
  // 除了引用，文字、类别、步骤和锚点都和 HP-1 一模一样。
  const twin = { ...scenario("HP-1", "lib/login.ts", 10, "进入首页", { step: 1 }), reference: "HP-2" };
  return { ...base, features: [{ ...base.features[0], scenarios: [...base.features[0].scenarios, twin] }, base.features[1]] };
};

async function importSnapshot(pool: Pool, organizationId: number, artifact: ReturnType<typeof snapshot>): Promise<{ productId: number; slug: string }> {
  const receipt = await importSnapshotArtifact({
    execute: pool.execute.bind(pool) as unknown as (statement: string, parameters?: unknown[]) => Promise<unknown>,
    currentContractVersion: CONTRACT_VERSION,
    organizationId,
    probeRemote: async () => ({ state: "unverified", reason: "rehearsal makes no network calls" }),
  }, artifact);
  mustBe(receipt.featuresImported === 2 && receipt.binding === "created", "导入应新建产品并建仓库行", receipt);
  return { productId: receipt.productId, slug: receipt.slug };
}

interface WorkbenchRow {
  id: number;
  featureId: number;
  featureName: string;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: string;
  stepOrder: number | null;
  evidence: string;
  source: string;
  active: number;
}

async function workbenchOf(pool: Pool, productId: number): Promise<WorkbenchRow[]> {
  const rows = await query(pool,
    "SELECT s.id, s.feature_id AS featureId, f.name AS featureName, s.reference, s.context, s.action, s.outcome, s.category, s.step_order AS stepOrder, s.evidence, s.source, s.active FROM scenarios s JOIN features f ON f.id = s.feature_id WHERE f.product_id = ? ORDER BY s.id",
    [productId]);
  return rows.map((row) => ({
    ...(row as unknown as WorkbenchRow),
    evidence: typeof row.evidence === "string" ? row.evidence : JSON.stringify(row.evidence),
  }));
}

/** 库里和工作台、版本、发布、run 有关的状态，用来证明演练没有留下任何东西。 */
async function footprint(pool: Pool, productId: number): Promise<string> {
  const [workbench, runs, versions, releases, changes] = await Promise.all([
    workbenchOf(pool, productId),
    query(pool, "SELECT r.id, r.status FROM analysis_runs r JOIN repositories repo ON repo.id = r.repository_id WHERE repo.product_id = ? ORDER BY r.id", [productId]),
    query(pool, "SELECT v.id FROM spec_versions v JOIN repositories repo ON repo.id = v.repository_id WHERE repo.product_id = ? ORDER BY v.id", [productId]),
    query(pool, "SELECT id FROM releases WHERE product_id = ? ORDER BY id", [productId]),
    query(pool, "SELECT c.id FROM changes c JOIN releases rel ON rel.id = c.release_id WHERE rel.product_id = ? ORDER BY c.id", [productId]),
  ]);
  return JSON.stringify([workbench, runs, versions, releases, changes]);
}

interface VersionScenario {
  featureName: string;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: string;
  stepOrder: number | null;
  evidence: string;
  source: string;
}

async function versionOf(pool: Pool, specVersionId: number): Promise<{ features: Row[]; scenarios: VersionScenario[] }> {
  const features = await query(pool, "SELECT name, stable_key AS stableKey, summary, source, identity_key AS identityKey FROM spec_features WHERE spec_version_id = ? ORDER BY id", [specVersionId]);
  const scenarios = (await query(pool,
    "SELECT f.name AS featureName, s.reference, s.context, s.action, s.outcome, s.category, s.step_order AS stepOrder, s.evidence, s.source FROM spec_scenarios s JOIN spec_features f ON f.id = s.spec_feature_id WHERE f.spec_version_id = ? ORDER BY s.id",
    [specVersionId])).map((row) => ({ ...(row as unknown as VersionScenario), evidence: typeof row.evidence === "string" ? row.evidence : JSON.stringify(row.evidence) }));
  return { features, scenarios };
}

const keyOf = (row: { featureName: string; reference: string }) => `${row.featureName}#${row.reference}`;

/** 锚点按含义比：导入存的是 endLine: null，合并入口的口径是省略不写，两者是同一个锚点。 */
function anchorsOf(evidence: string): string[] {
  return (JSON.parse(evidence) as Array<{ path: string; startLine?: number | null; endLine?: number | null }>)
    .map((anchor) => `${anchor.path}:${anchor.startLine ?? "-"}:${anchor.endLine ?? "-"}`)
    .sort();
}

async function main(): Promise<string[]> {
  const url = process.env[ENV_URL];
  if (!url) throw new Error(`请用环境变量 ${ENV_URL} 给出一个库名以 ${SCRATCH_PREFIX} 开头的连接地址`);
  const summary: string[] = [];
  await withScratchDatabase({ url, prefix: SCRATCH_PREFIX, envName: ENV_URL }, async (pool, info) => {
    const realFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error("演练期间不允许任何网络调用");
    }) as typeof fetch;
    try {
      summary.push(`MySQL ${info.serverVersion}，从零执行了 ${info.migrations} 个迁移`);
      const organizationId = insertIdOf(await pool.execute("INSERT INTO organizations (slug, name) VALUES (?, ?)", ["backfill-org", "Backfill Org"]));
      const options = (apply: boolean, extra: { acceptDedupe?: boolean } = {}) => ({ apply, committedAt: COMMITTED_AT, currentContractVersion: CONTRACT_VERSION, now: () => new Date("2026-11-27T02:00:00.000Z"), ...extra });

      // 1. 真实导入，然后像编辑服务那样改一条、删一条。
      const clean = await importSnapshot(pool, organizationId, snapshot("airecord", "a".repeat(40)));
      const edited = (await workbenchOf(pool, clean.productId)).find((row) => row.featureName === "登录" && row.reference === "EC-1");
      const removed = (await workbenchOf(pool, clean.productId)).find((row) => row.featureName === "登录" && row.reference === "ER-1");
      mustBe(!!edited && !!removed, "导入应写下要改和要删的两条场景", { edited, removed });
      await pool.execute("UPDATE scenarios SET outcome = '人工改过的结果', source = 'manual' WHERE id = ?", [edited.id]);
      await pool.execute("UPDATE scenarios SET active = 0, source = 'manual' WHERE id = ?", [removed.id]);
      const draftBefore = await workbenchOf(pool, clean.productId);
      mustBe(draftBefore.length === 5 && draftBefore.filter((row) => row.source === "ai_snapshot_import").length === 3, "草稿应有 5 条场景，其中 3 条仍是导入原样", draftBefore.map((row) => [row.reference, row.source]));
      const before = await footprint(pool, clean.productId);

      // 2. 演练：真做一遍再回滚。
      const candidate = await loadBackfillCandidate(pool.execute.bind(pool) as unknown as (statement: string, parameters?: unknown[]) => Promise<unknown>, { slug: clean.slug, organizationId });
      mustBe(candidate !== null && blockagesOf(candidate, options(false)).length === 0, "干净的草稿不应有阻断项", candidate);
      const rehearsal = await backfillImportDraft(pool, { slug: clean.slug, organizationId }, options(false));
      mustBe(rehearsal.dryRun && rehearsal.droppedDraft.length === 0 && rehearsal.version.features === 2 && rehearsal.version.scenarios === 4, "演练应报告：没有会被去掉的场景；版本是 2 个功能、4 条场景（3 条草稿 + 1 条人工改过的）", rehearsal);
      mustBe(rehearsal.draft.withoutEvidence === 1 && rehearsal.version.manualScenarios === 1, "演练应数出一条没有证据的场景和一条人工场景", rehearsal);
      mustBe((await footprint(pool, clean.productId)) === before, "演练之后库里的每一个字节都应和演练之前相同");
      mustBe(fetchCalls.length === 0, "演练不应有任何网络调用", fetchCalls);
      summary.push(`演练：版本 ${rehearsal.version.features} 个功能 / ${rehearsal.version.scenarios} 个场景，发布页 ${rehearsal.releaseChanges} 条；回滚后库里逐字节未变`);

      // 3. 写入。
      const written: ImportBackfillReceipt = await backfillImportDraft(pool, { slug: clean.slug, organizationId }, options(true));
      mustBe(!written.dryRun, "写入的回执不应标成演练", written);
      const repositoryId = written.repositoryId;
      const run = (await query(pool, "SELECT * FROM analysis_runs WHERE id = ?", [written.runId]))[0];
      mustBe(run?.trigger_type === IMPORT_BACKFILL_TRIGGER && run.status === "succeeded" && run.after_sha === "a".repeat(40) && run.before_sha === null && run.client_idempotency_key === null && run.account_id === Number(organizationId), "run 应是一条完成的回填回执", run);
      mustBe(run.finished_at !== null && run.error_message === null, "回填的 run 提交时就应带着完成时间、没有错误", run);
      const version = (await query(pool, "SELECT * FROM spec_versions WHERE id = ?", [written.specVersionId]))[0];
      mustBe(version?.analysis_run_id === written.runId && version.repository_id === repositoryId && version.product_id === clean.productId && String(version.sha) === "a".repeat(40) && version.base_spec_version_id === null && version.output_language === "zh-CN", "版本应挂在回填的 run、仓库和快照对应的提交上", version);
      const provenance = clientProvenanceOf(version.provenance_json);
      mustBe(JSON.stringify(provenance) === JSON.stringify({ executor: "client", entry: "import_backfill" }), "页面上读出来应是「由导入的雷达快照回填」", provenance);
      const stored = typeof version.provenance_json === "string" ? JSON.parse(version.provenance_json) : version.provenance_json;
      mustBe(stored.client === null && stored.server.executor === "client" && stored.server.entry === "import_backfill" && stored.server.verification.scope === "none" && stored.server.revisionSha === "a".repeat(40) && stored.server.contractVersion === CONTRACT_VERSION && stored.server.specVersionId === written.specVersionId, "来源信息应说清：客户端分析、由导入回填、服务端没有做核对、没有记录任何客户端声明", stored);

      const { features: versionFeatures, scenarios: versionScenarios } = await versionOf(pool, written.specVersionId);
      mustBe(versionFeatures.length === 2 && versionScenarios.length === 4, "版本应有 2 个功能（导入的 2 个，不多不少）和 4 条场景（3 条草稿 + 1 条人工改过的；人工删掉的那条不在）", { features: versionFeatures.length, scenarios: versionScenarios.length });
      const byKey = new Map(versionScenarios.map((row) => [keyOf(row), row]));
      // 只有导入原样的行要求逐字进版本；人工改过和删掉的两条另有断言。
      for (const row of draftBefore.filter((item) => item.source === "ai_snapshot_import")) {
        const inVersion = byKey.get(keyOf(row));
        mustBe(inVersion !== undefined, `草稿场景 ${keyOf(row)} 应在版本里`, [...byKey.keys()]);
        if (row.source === "ai_snapshot_import") {
          mustBe(inVersion.source === "generated" && inVersion.context === row.context && inVersion.action === row.action && inVersion.outcome === row.outcome && inVersion.category === row.category && String(inVersion.stepOrder) === String(row.stepOrder) && JSON.stringify(anchorsOf(inVersion.evidence)) === JSON.stringify(anchorsOf(row.evidence)), `草稿场景 ${keyOf(row)} 的文字、类别、步骤和锚点应逐字相同`, { inVersion, row });
        }
      }
      mustBe(byKey.get("登录#EC-1")?.source === "manual" && byKey.get("登录#EC-1")?.outcome === "人工改过的结果", "人工改过的那条在版本里应是人工的那份内容", byKey.get("登录#EC-1"));
      mustBe(!byKey.has("登录#ER-1"), "人工删掉的那条不应回到版本里", [...byKey.keys()]);
      mustBe(versionFeatures.map((feature) => String(feature.name)).sort().join() === "导出,登录" && versionFeatures.every((feature) => typeof feature.identityKey === "string" && feature.identityKey !== "" && feature.source === "generated"), "版本里的两个功能都来自导入，来源是 generated，都带身份", versionFeatures);

      const after = await workbenchOf(pool, clean.productId);
      mustBe(after.map((row) => row.id).join() === draftBefore.map((row) => row.id).join(), "工作台场景行的编号不应变", { before: draftBefore.map((row) => row.id), after: after.map((row) => row.id) });
      mustBe(after.filter((row) => row.source === "ai_snapshot_import").length === 0 && after.filter((row) => row.source === "generated").length === 3 && after.every((row) => row.active === (row.reference === "ER-1" ? 0 : 1)), "导入的行应变成 generated 且都在用；人工删的那条仍停用", after.map((row) => [row.reference, row.source, row.active]));
      mustBe(after.filter((row) => row.source === "generated").every((row) => row.context === draftBefore.find((item) => item.id === row.id)!.context && row.outcome === draftBefore.find((item) => item.id === row.id)!.outcome && JSON.stringify(anchorsOf(row.evidence)) === JSON.stringify(anchorsOf(draftBefore.find((item) => item.id === row.id)!.evidence))), "变成 generated 的行内容不应变");
      const workbenchIdentities = await query(pool, "SELECT f.identity_key AS featureKey, s.identity_key AS scenarioKey FROM scenarios s JOIN features f ON f.id = s.feature_id WHERE f.product_id = ? AND s.source = 'generated'", [clean.productId]);
      mustBe(workbenchIdentities.length === 3 && workbenchIdentities.every((row) => typeof row.featureKey === "string" && typeof row.scenarioKey === "string"), "变成 generated 的工作台行应补上身份", workbenchIdentities);

      const release = (await query(pool, "SELECT * FROM releases WHERE id = ?", [written.releaseId]))[0];
      mustBe(release?.spec_version_id === written.specVersionId && release.analysis_run_id === written.runId && Number(release.is_current) === 1 && String(release.sha) === "a".repeat(40) && release.url === `https://github.com/acme/airecord/commit/${"a".repeat(40)}` && new Date(release.committed_at as string).toISOString() === COMMITTED_AT, "发布应指向版本、是当前发布、登记在给出的提交时间和 github 的提交页上", release);
      mustBe(release.title === "首个账本版本（由导入的雷达快照回填）" && String(release.summary).includes("没有为它读过源码"), "发布的标题和说明应说明它是回填", { title: release.title, summary: release.summary });
      mustBe(written.releaseChanges === 2, "首个版本应把 2 个功能都列为新增", written);
      const changeKinds = await query(pool, "SELECT kind, COUNT(*) AS count FROM changes WHERE release_id = ? GROUP BY kind", [written.releaseId]);
      mustBe(changeKinds.length === 1 && changeKinds[0].kind === "added" && Number(changeKinds[0].count) === 2, "发布页的变化应全是「新增」", changeKinds);
      const regressionTasks = Number((await query(pool, "SELECT COUNT(*) AS count FROM regression_tasks WHERE release_id = ?", [written.releaseId]))[0]?.count ?? -1);
      const product = (await query(pool, "SELECT description, description_source AS descriptionSource FROM products WHERE id = ?", [clean.productId]))[0];
      mustBe(product?.description === "airecord 的简介，随快照导入" && product.descriptionSource === "ai_snapshot_import", "导入时写的简介应原样保留", product);
      const fileIndex = await query(pool, "SELECT COUNT(*) AS count FROM spec_file_index WHERE spec_version_id = ?", [written.specVersionId]);
      mustBe(Number(fileIndex[0]?.count ?? 0) >= 3, "版本应建好文件索引（至少登录、导出和简介提到的路径）", fileIndex);
      mustBe(fetchCalls.length === 0, "写入不应有任何网络调用", fetchCalls);
      summary.push(`写入：run ${written.runId}、版本 ${written.specVersionId}（${versionScenarios.length} 条场景，其中草稿 3 条逐字核对、人工 1 条）、发布 ${written.releaseId}（${changeKinds[0].count} 条新增、${regressionTasks} 个回归任务）；工作台 ${after.length} 行编号不变；零网络调用`);

      // 4. 重跑。
      const afterWrite = await footprint(pool, clean.productId);
      await expectRefused(() => backfillImportDraft(pool, { slug: clean.slug, organizationId }, options(true)), "already_has_versions");
      mustBe((await footprint(pool, clean.productId)) === afterWrite, "被拒绝的重跑不应改动任何东西");
      summary.push("重跑：已有版本，拒绝（already_has_versions），库里未变");

      // 5. 去重。
      const duplicated = await importSnapshot(pool, organizationId, withDuplicates("dup-repo", "d".repeat(40)));
      const duplicatedDraft = await workbenchOf(pool, duplicated.productId);
      mustBe(duplicatedDraft.length === 6, "带重复的草稿应有 6 条场景", duplicatedDraft.length);
      const duplicatedBefore = await footprint(pool, duplicated.productId);
      const rehearsalWithTwin = await backfillImportDraft(pool, { slug: duplicated.slug, organizationId }, options(false));
      mustBe(rehearsalWithTwin.droppedDraft.length === 1 && rehearsalWithTwin.droppedDraft[0].feature === "登录" && rehearsalWithTwin.droppedDraft[0].reference === "HP-2", "演练应点出会被去掉的那一条", rehearsalWithTwin.droppedDraft);
      mustBe((await footprint(pool, duplicated.productId)) === duplicatedBefore, "带重复的演练回滚后库里也应未变");
      await expectRefused(() => backfillImportDraft(pool, { slug: duplicated.slug, organizationId }, options(true)), "draft_duplicates");
      mustBe((await footprint(pool, duplicated.productId)) === duplicatedBefore, "没有接受就去重的写入被拒绝，库里未变");
      const accepted = await backfillImportDraft(pool, { slug: duplicated.slug, organizationId }, options(true, { acceptDedupe: true }));
      const duplicatedAfter = await workbenchOf(pool, duplicated.productId);
      const twinRow = duplicatedAfter.find((row) => row.reference === "HP-2");
      mustBe(!accepted.dryRun && twinRow?.active === 0 && twinRow.source === "generated" && duplicatedAfter.filter((row) => row.active === 1).length === 5, "接受之后写入：重复的那一行停用、行还在，其余 5 行在用", duplicatedAfter.map((row) => [row.reference, row.source, row.active]));
      summary.push("去重：演练点出 1 条；未接受的写入被拒绝且未变；接受后写入，重复的行停用");

      // 6. 不满足条件。
      const dirty = await importSnapshot(pool, organizationId, snapshot("dirty-repo", "e".repeat(40), true));
      await expectRefused(() => backfillImportDraft(pool, { slug: dirty.slug, organizationId }, options(false)), "dirty_snapshot");
      await expectRefused(() => backfillImportDraft(pool, { slug: "no-such-product", organizationId }, options(false)), "product_not_found");
      await expectRefused(() => backfillImportDraft(pool, { slug: clean.slug, organizationId: 999_999 }, options(false)), "product_not_found");
      summary.push("条件不满足：工作区不干净的快照、不存在的产品都拒绝");

      // 7. 隔离：回填的 run 即使被改回排队，服务端也不执行它。
      await pool.execute("UPDATE analysis_runs SET status = 'queued', finished_at = NULL WHERE id = ?", [written.runId]);
      await runAnalysis(written.runId);
      const refusedRun = (await query(pool, "SELECT status, error_message AS errorMessage FROM analysis_runs WHERE id = ?", [written.runId]))[0];
      mustBe(refusedRun?.status === "failed" && String(refusedRun.errorMessage).startsWith(`analysis_mode_is_client: a ${IMPORT_BACKFILL_TRIGGER} run is the receipt of an import backfill`), "回填的 run 交给 runAnalysis 应被标失败并说明它是回执", refusedRun);
      summary.push(`隔离：回填的 run 被标失败（${String(refusedRun?.errorMessage).slice(0, 80)}…）`);
      mustBe(fetchCalls.length === 0, "整个演练不应有任何网络调用", fetchCalls);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  return summary;
}

async function expectRefused(work: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await work();
  } catch (error) {
    mustBe(error instanceof ImportBackfillRefused && error.blockages.some((blockage) => blockage.code === code), `应被拒绝，原因里有 ${code}`, error instanceof Error ? error.message : error);
    return;
  }
  throw new Error(`应被拒绝（${code}），却成功了`);
}

main()
  .then((summary) => console.log(summary.map((line, index) => `${index + 1}. ${line}`).join("\n")))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
