#!/usr/bin/env node
/**
 * Task 15 bench 导出：把 scratch 库中指定 mode 最新一次 succeeded run 的
 * 规格（features/scenarios）、覆盖回执、完整性账本、成本遥测、过程门禁证据
 * 导出为 JSON（供盲评与对照文件组装）。用法：
 *   node scripts/bench-export.cjs legacy|inventory [outFile]
 */
const mysql = require("/data/www/codelphi-bench/app/node_modules/mysql2/promise");
const fs = require("fs");

const url = new URL(
  fs.readFileSync("/data/www/codelphi-bench/app/.env", "utf8")
    .split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=")).slice(14).trim(),
);
const mode = process.argv[2] === "inventory" ? "inventory" : "legacy";
const out = process.argv[3] || `/data/www/codelphi-bench/outputs/${mode}.json`;

(async () => {
  const conn = await mysql.createConnection({
    host: url.hostname, port: Number(url.port || 3306),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: "codelphi_bench", charset: "utf8mb4", ssl: false,
  });
  const [runs] = await conn.query(
    `SELECT r.id, r.status, r.error_message, r.started_at, r.finished_at, v.id AS specVersionId
     FROM analysis_runs r
     LEFT JOIN spec_versions v ON v.analysis_run_id = r.id
     WHERE r.id IN (SELECT MAX(id) FROM analysis_runs WHERE trigger_type = 'manual' AND status = 'succeeded')`,
  );
  const run = runs[0];
  if (!run || run.specVersionId == null) {
    console.error(`EXPORT_FAIL: no succeeded run with a spec version for mode=${mode}`);
    process.exit(1);
  }
  const [features] = await conn.query(
    `SELECT f.id, f.stable_key AS stableKey, f.name, f.summary, f.parent_key AS parentKey, f.source,
            s.reference, s.context, s.action, s.outcome, s.category, s.source AS scenarioSource, s.evidence
     FROM spec_features f
     LEFT JOIN spec_scenarios s ON s.spec_feature_id = f.id
     WHERE f.spec_version_id = ?
     ORDER BY f.position, f.id, s.step_order, s.id`,
    [run.specVersionId],
  );
  const featureMap = new Map();
  for (const row of features) {
    if (!featureMap.has(row.id)) {
      featureMap.set(row.id, { name: row.name, summary: row.summary, parentKey: row.parentKey, scenarios: [] });
    }
    if (row.reference != null) {
      let evidence = [];
      try { evidence = typeof row.evidence === "string" ? JSON.parse(row.evidence) : (row.evidence ?? []); } catch { evidence = []; }
      featureMap.get(row.id).scenarios.push({
        reference: row.reference, context: row.context, action: row.action,
        outcome: row.outcome, category: row.category, source: row.scenarioSource, evidence,
      });
    }
  }
  const [coverage] = await conn.query(
    "SELECT * FROM analysis_coverage_receipts WHERE spec_version_id = ? ORDER BY id DESC LIMIT 1", [run.specVersionId],
  );
  const [ledger] = await conn.query(
    "SELECT * FROM analysis_completeness_ledger WHERE run_id = ? ORDER BY id DESC LIMIT 1", [run.id],
  );
  const [manifest] = await conn.query(
    "SELECT id, manifest_hash FROM analysis_behavior_manifests WHERE run_id = ?", [run.id],
  );
  const [receipts] = await conn.query(
    `SELECT COUNT(*) AS llmCalls,
            COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
            COALESCE(SUM(llm_cost_amount), 0) AS costAmount,
            MIN(created_at) AS firstCall, MAX(created_at) AS lastCall
     FROM llm_call_receipts WHERE run_id = ?`, [run.id],
  );
  const result = {
    mode,
    run: { id: run.id, status: run.status, specVersionId: run.specVersionId, startedAt: run.started_at, finishedAt: run.finished_at, error: run.error_message },
    spec: { specVersionId: run.specVersionId, features: [...featureMap.values()] },
    coverage: coverage[0] ?? null,
    ledger: ledger[0] ?? null,
    manifest: manifest[0] ? { id: manifest[0].id } : null,
    cost: {
      llmCalls: Number(receipts[0].llmCalls),
      totalTokens: Number(receipts[0].totalTokens),
      costAmount: Number(receipts[0].costAmount),
      currency: "CNY",
    },
  };
  fs.mkdirSync("/data/www/codelphi-bench/outputs", { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  const scenarioCount = result.spec.features.reduce((t, f) => t + f.scenarios.length, 0);
  console.log(JSON.stringify({ exported: out, mode, runId: run.id, features: result.spec.features.length, scenarios: scenarioCount, status: run.status }));
  await conn.end();
})().catch((error) => {
  console.error("EXPORT_FAIL:", error.message);
  process.exit(1);
});
