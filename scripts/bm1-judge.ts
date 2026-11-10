import "dotenv/config";
import { getDb } from "../lib/db";
import { writeFileSync } from "node:fs";

// BM-1 判定脚本（临时）：v48 基线 vs 当前最新版本 逐字对比 + GT 自动归类
const BASELINE_VERSION_ID = 48;
const REPO_ID = 5;

// 与 docs/benchmark/frozen/superset-2026-11-10-incremental/prelabels.md 一致（判定脚本独立持有，防漂移）
const GT_AFFECTED = ["sql 编辑器", "仪表盘", "发布流程工具", "安全角色与认证", "嵌入式仪表盘", "数据库连接配置", "数据源连接", "缓存层"];
const GT_UNAFFECTED = [
  "databricks sql lab", "databricks sql lab 查询取消", "databricks 查询取消", "docker 部署", "oauth2 客户端配置",
  "仪表盘布局保存", "前端插件构建", "图表列表与数据源过滤", "图表列表数据源筛选", "图表列表数据源过滤",
  "图表创建数据源入口", "图表创建数据源选择", "图表数据查询", "图表构建与可视化", "安全依赖管理",
  "导入导出", "导入导出密钥处理", "导入弹窗", "嵌入 sdk", "嵌入式 sdk", "嵌入式访客凭据回退",
  "嵌入式访客回退凭据", "数据导入导出", "语义层", "语义层提供方传输", "语义视图创建结果解析",
  "语义视图批量删除", "语义视图批量添加", "资产导入导出",
];
const GT_UNKNOWN = ["rest api", "数据集列表管理"];
const MECHANICAL_AFFECTED = ["发布流程工具", "rest api", "sql 编辑器", "安全角色与认证", "数据源连接", "语义视图批量删除", "安全依赖管理", "嵌入式访客凭据回退", "数据库连接配置", "数据集列表管理", "仪表盘"];

type Scen = { reference: string; category: string; context: string; action: string; outcome: string };
type Feat = { stableKey: string; name: string; summary: string; scenarios: Scen[] };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const eq = (a: string, b: string) => a === b;
const eqNorm = (a: string, b: string) => norm(a) === norm(b);
const scenEq = (x: Scen, y: Scen) => ({
  exact: eq(x.context, y.context) && eq(x.action, y.action) && eq(x.outcome, y.outcome),
  normalized: eqNorm(x.context, y.context) && eqNorm(x.action, y.action) && eqNorm(x.outcome, y.outcome),
});

async function loadVersion(db: Awaited<ReturnType<typeof getDb>>, versionId: number): Promise<Map<string, Feat>> {
  const [features] = await db.execute(
    "SELECT id, stable_key AS stableKey, name, summary FROM spec_features WHERE spec_version_id = ? ORDER BY position, id",
    [versionId],
  );
  const map = new Map<string, Feat>();
  for (const f of features as Array<{ id: number; stableKey: string; name: string; summary: string }>) {
    const [scens] = await db.execute(
      "SELECT reference, category, context, action, outcome FROM spec_scenarios WHERE spec_feature_id = ? ORDER BY reference",
      [f.id],
    );
    map.set(f.stableKey, {
      stableKey: f.stableKey, name: f.name, summary: f.summary,
      scenarios: scens as Scen[],
    });
  }
  return map;
}

async function main() {
  const db = getDb();
  try {
    const [latestRows] = await db.execute(
      "SELECT id, analysis_run_id AS runId, sha FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1",
      [REPO_ID],
    );
    const latest = (latestRows as Array<{ id: number; runId: number; sha: string }>)[0];
    if (!latest || latest.id === BASELINE_VERSION_ID) throw new Error(`no new version beyond v${BASELINE_VERSION_ID}`);
    console.log(`comparing v${BASELINE_VERSION_ID} (run ?) -> v${latest.id} (run ${latest.runId}, sha ${latest.sha.slice(0, 7)})`);

    const base = await loadVersion(db, BASELINE_VERSION_ID);
    const curr = await loadVersion(db, latest.id);

    const gtOf = (key: string) =>
      GT_AFFECTED.includes(key) ? "affected" : GT_UNAFFECTED.includes(key) ? "unaffected" : GT_UNKNOWN.includes(key) ? "unknown" : "not_in_gt";

    const report: string[] = [];
    const rollup = { affected: { kept: 0, changed: 0, dropped: 0, newKeys: 0 }, unaffected: { kept: 0, changed: 0, dropped: 0, newKeys: 0 }, unknown: { kept: 0, changed: 0, dropped: 0, newKeys: 0 }, not_in_gt: { newKeys: 0 } };
    const upFailures: string[] = [];
    const changedAffected: string[] = [];

    const allKeys = [...new Set([...base.keys(), ...curr.keys()])];
    for (const key of allKeys) {
      const gt = gtOf(key);
      const b = base.get(key);
      const c = curr.get(key);
      if (!b) {
        rollup[gt as "not_in_gt"].newKeys++;
        report.push(`\n## [NEW 功能/${gt}] ${c!.name} [${key}]`);
        report.push(`summary: ${c!.summary}`);
        for (const s of c!.scenarios) report.push(`  + [${s.category}] ${s.reference}: C=${norm(s.context).slice(0, 90)} | A=${norm(s.action).slice(0, 90)} | O=${norm(s.outcome).slice(0, 90)}`);
        continue;
      }
      if (!c) {
        rollup[gt as "unaffected"].dropped++;
        report.push(`\n## [DROPPED 功能/${gt}] ${b.name} [${key}] — v48 有 v49 无`);
        continue;
      }
      const summaryExact = eq(b.summary, c.summary);
      const scenRefs = [...new Set([...b.scenarios.map((s) => s.reference), ...c.scenarios.map((s) => s.reference)])];
      const identical: string[] = [];
      const changed: string[] = [];
      const added: string[] = [];
      const removed: string[] = [];
      for (const ref of scenRefs) {
        const bs = b.scenarios.find((s) => s.reference === ref);
        const cs = c.scenarios.find((s) => s.reference === ref);
        if (bs && !cs) { removed.push(ref); continue; }
        if (!bs && cs) { added.push(ref); continue; }
        const e = scenEq(bs!, cs!);
        if (e.exact) identical.push(ref);
        else changed.push(`${ref}(${e.normalized ? "norm-only" : "rewritten"})`);
      }
      const untouched = summaryExact && changed.length === 0 && added.length === 0 && removed.length === 0;
      const bucket = rollup[gt as "unaffected"];
      if (untouched) bucket.kept++;
      else bucket.changed++;
      if (gt === "unaffected" && !untouched) {
        upFailures.push(`${b.name} [${key}] summaryExact=${summaryExact} changed=[${changed.join(",")}] added=[${added.join(",")}] removed=[${removed.join(",")}]`);
      }
      if (gt === "affected" && !untouched) changedAffected.push(key);
      report.push(`\n## [${untouched ? "KEPT" : "CHANGED"}/${gt}] ${b.name} [${key}]`);
      if (!summaryExact) report.push(`  summary ${summaryExact ? "exact" : eqNorm(b.summary, c.summary) ? "norm-only" : "REWRITTEN"}:`);
      if (!summaryExact) { report.push(`    v48: ${norm(b.summary).slice(0, 160)}`); report.push(`    v49: ${norm(c.summary).slice(0, 160)}`); }
      if (identical.length) report.push(`  逐字相同场景: ${identical.join(", ")}`);
      if (changed.length) for (const ch of changed) {
        const ref = ch.split("(")[0];
        const bs = b.scenarios.find((s) => s.reference === ref)!;
        const cs = c.scenarios.find((s) => s.reference === ref)!;
        report.push(`  ~ ${ch}:`);
        for (const [lbl, x, y] of [["C", bs.context, cs.context], ["A", bs.action, cs.action], ["O", bs.outcome, cs.outcome]] as const) {
          if (!eq(x, y)) { report.push(`    ${lbl} v48: ${norm(x).slice(0, 140)}`); report.push(`    ${lbl} v49: ${norm(y).slice(0, 140)}`); }
        }
      }
      if (added.length) for (const ref of added) {
        const cs = c.scenarios.find((s) => s.reference === ref)!;
        report.push(`  + ${ref} [${cs.category}] C=${norm(cs.context).slice(0, 110)} | A=${norm(cs.action).slice(0, 110)} | O=${norm(cs.outcome).slice(0, 110)}`);
      }
      if (removed.length) report.push(`  - 移除场景: ${removed.join(", ")}`);
    }

    // 运行事实：changes / 覆盖回执 / 完整性账本
    const [changes] = await db.execute(
      "SELECT id, entity_type AS entityType, kind, feature_key AS featureKey, feature_name AS featureName, scenario_reference AS scenarioRef, summary FROM spec_changes WHERE spec_version_id = ? ORDER BY id",
      [latest.id],
    );
    const [receipt] = await db.execute(
      "SELECT * FROM analysis_coverage_receipts WHERE spec_version_id = ?",
      [latest.id],
    );
    const [ledger] = await db.execute(
      "SELECT overall, details FROM analysis_completeness_ledger WHERE run_id = ?",
      [latest.runId],
    );
    const [llm] = await db.execute(
      "SELECT COUNT(*) AS calls, COALESCE(SUM(llm_cost_amount), 0) AS cost FROM llm_call_receipts WHERE run_id = ?",
      [latest.runId],
    );

    const summary = {
      version: { from: BASELINE_VERSION_ID, to: latest.id, runId: latest.runId },
      rollup,
      upFailures,
      changedAffectedKeys: changedAffected,
      gtSanity: {
        affectedTotal: GT_AFFECTED.length, unaffectedTotal: GT_UNAFFECTED.length, unknownTotal: GT_UNKNOWN.length,
        mechanicalPredicted: MECHANICAL_AFFECTED.length,
      },
      changesCount: (changes as unknown[]).length,
    };
    writeFileSync("/tmp/bm1-judge-latest.json", JSON.stringify({ summary, changes, receipt: receipt ?? null, ledger: ledger ?? null, llm: llm ?? null }, null, 2));
    writeFileSync("/tmp/bm1-judge-latest.md", report.join("\n") + "\n");
    console.log(JSON.stringify(summary, null, 2));
    console.log("\nUP 失败清单见 /tmp/bm1-judge-latest.md 与 upFailures；明细 JSON /tmp/bm1-judge-latest.json");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
