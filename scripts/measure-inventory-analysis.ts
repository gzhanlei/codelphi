#!/usr/bin/env tsx
/**
 * Task 15 · inventory vs legacy 配对行为 benchmark 的离线测量入口。
 *
 * 显式 shadow/离线工具：只读取人工冻结的对照 JSON（协议与 schema 见
 * docs/benchmark/frozen/behavior-inventory-v1.md / behavior-inventory-v1.schema.json），
 * 计算配对统计并输出判定。本脚本：
 *  - 不连接数据库、不调用 AI、不读写任何规格/激活状态、不部署任何资源；
 *  - 不读取也不修改 FULL_ANALYSIS_MODE——是否启用 inventory 是人工验收之后的独立决定；
 *  - 输入必须由未查看新旧输出的评审先冻结（见协议文档）；脚本只负责统计，不产生人工判定。
 *
 * 用法：
 *   tsx scripts/measure-inventory-analysis.ts --input <comparison.json> [--input <comparison.json> ...] [--out <report.json>]
 *
 * 退出码：0 = passed；1 = failed（含过程门禁未通过）；2 = inconclusive；3 = 用法/输入校验错误。
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  evaluateBehaviorNonInferiority,
  type BenchmarkVerdict,
  type PairedBehaviorOutcome,
  type RepoComparison,
} from "../lib/behavior-benchmark";

const SCHEMA_ID = "behavior-inventory-v1";

interface CliArgs {
  inputs: string[];
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { inputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      const value = argv[++index];
      if (!value) throw new Error("--input requires a file path");
      args.inputs.push(value);
    } else if (arg === "--out") {
      const value = argv[++index];
      if (!value) throw new Error("--out requires a file path");
      args.out = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: tsx scripts/measure-inventory-analysis.ts --input <comparison.json> [--input ...] [--out <report.json>]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.inputs.length === 0) throw new Error("at least one --input <comparison.json> is required (explicit shadow/offline inputs only)");
  return args;
}

function fail(field: string, detail: string): never {
  throw new Error(`invalid comparison file (${field}): ${detail}`);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(field, "expected an object");
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field, "expected a boolean");
  return value;
}

function asNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(field, "expected a non-negative integer");
  return value;
}

/** 解析并校验单仓对照文件 → RepoComparison + 直通遥测。 */
function parseComparison(raw: unknown, source: string): { comparison: RepoComparison; telemetry: Record<string, unknown>; processGatesPassed: boolean } {
  const root = asRecord(raw, source);
  if (root.schema !== SCHEMA_ID) fail("schema", `expected "${SCHEMA_ID}", got ${JSON.stringify(root.schema)}`);
  const repo = typeof root.repo === "string" && root.repo.length > 0 ? root.repo : fail("repo", "expected a non-empty string");

  const behaviors = Array.isArray(root.behaviors) ? root.behaviors : fail("behaviors", "expected an array");
  const pairs: PairedBehaviorOutcome[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of behaviors.entries()) {
    const record = asRecord(entry, `behaviors[${index}]`);
    const behaviorId = typeof record.behaviorId === "string" && record.behaviorId.length > 0 ? record.behaviorId : fail(`behaviors[${index}].behaviorId`, "expected a non-empty string");
    if (seenIds.has(behaviorId)) fail(`behaviors[${index}].behaviorId`, `duplicate behaviorId "${behaviorId}"`);
    seenIds.add(behaviorId);
    for (const required of ["sourceLocation", "description", "observableOutcome"] as const) {
      if (record[required] == null) fail(`behaviors[${index}].${required}`, "required by the frozen protocol");
    }
    // 每条冻结行为必须已在两条路径上完成盲评判定；未判定即分母不完整，拒绝测量
    const hits = record.hits != null ? asRecord(record.hits, `behaviors[${index}].hits`) : fail(`behaviors[${index}].hits`, "every frozen behavior must be judged on both paths before measurement");
    pairs.push({
      behaviorId,
      legacyHit: asBoolean(hits.legacy, `behaviors[${index}].hits.legacy`),
      inventoryHit: asBoolean(hits.inventory, `behaviors[${index}].hits.inventory`),
    });
  }

  const comparison: RepoComparison = { repo, pairs };
  const evaluation = root.outputEvaluation != null ? asRecord(root.outputEvaluation, "outputEvaluation") : null;
  if (evaluation) {
    const parseSide = (path: "legacy" | "inventory") => {
      const side = asRecord(evaluation[path], `outputEvaluation.${path}`);
      const evaluatedOutputs = asNonNegativeInt(side.evaluatedOutputs, `outputEvaluation.${path}.evaluatedOutputs`);
      const falsePositives = asNonNegativeInt(side.falsePositives, `outputEvaluation.${path}.falsePositives`);
      const evidenceSupported = asNonNegativeInt(side.evidenceSupported, `outputEvaluation.${path}.evidenceSupported`);
      if (evaluatedOutputs === 0) fail(`outputEvaluation.${path}.evaluatedOutputs`, "must be > 0 when outputEvaluation is declared (per-path denominator)");
      if (falsePositives > evaluatedOutputs) fail(`outputEvaluation.${path}.falsePositives`, "cannot exceed evaluatedOutputs");
      if (evidenceSupported > evaluatedOutputs) fail(`outputEvaluation.${path}.evidenceSupported`, "cannot exceed evaluatedOutputs");
      return { evaluatedOutputs, falsePositives, evidenceSupported };
    };
    const legacy = parseSide("legacy");
    const inventory = parseSide("inventory");
    // 两路径分母各自独立（各路径实际评估的输出行为数）；unmatched 输出只列在 telemetry，不进配对
    comparison.falsePositives = {
      legacy: { falsePositives: legacy.falsePositives, evaluatedOutputs: legacy.evaluatedOutputs },
      inventory: { falsePositives: inventory.falsePositives, evaluatedOutputs: inventory.evaluatedOutputs },
    };
    comparison.evidenceSupport = {
      legacy: { supported: legacy.evidenceSupported, evaluatedOutputs: legacy.evaluatedOutputs },
      inventory: { supported: inventory.evidenceSupported, evaluatedOutputs: inventory.evaluatedOutputs },
    };
  }

  // 过程门禁（设计 §9.5：单元清单/区间/锚点/激活门禁必须先全部通过，benchmark 不能抵消过程缺陷）
  const gates = root.processGates != null ? asRecord(root.processGates, "processGates") : null;
  const processGatesPassed = gates != null
    && asBoolean(gates.inventoryManifestValid, "processGates.inventoryManifestValid")
    && asBoolean(gates.coverageGatesPassed, "processGates.coverageGatesPassed")
    && asBoolean(gates.activationGatePassed, "processGates.activationGatePassed");

  // 误报率差值之外的遥测（拆分/合并、未决、成本、耗时、unmatched 输出）直通报告，分别展示
  const telemetry: Record<string, unknown> = {};
  for (const key of ["revision", "frozenAt", "frozenBy", "unmatchedOutputs", "splitMerge", "unresolved", "cost"] as const) {
    if (root[key] !== undefined) telemetry[key] = root[key];
  }
  return { comparison, telemetry, processGatesPassed };
}

interface MeasuredRepo {
  comparison: RepoComparison;
  telemetry: Record<string, unknown>;
  processGatesPassed: boolean;
  source: string;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const measured: MeasuredRepo[] = args.inputs.map((input) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(input, "utf8"));
    } catch (error) {
      throw new Error(`cannot read ${input}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...parseComparison(raw, input), source: input };
  });

  const verdict: BenchmarkVerdict = evaluateBehaviorNonInferiority(measured.map((entry) => entry.comparison));

  // 过程门禁失败/缺失：配对统计照算（供诊断），但整体结论强制不得为 passed
  const gateFailures = measured.filter((entry) => !entry.processGatesPassed);
  if (gateFailures.length > 0 && verdict.status === "passed") {
    verdict.status = "failed";
  }
  for (const entry of gateFailures) {
    verdict.reasons.push(`仓库 ${entry.comparison.repo} 的过程门禁未声明或未全部通过（processGates）：benchmark 不能抵消过程缺陷`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "shadow-offline",
    note: "人工 shadow 验收结果；本报告不构成 FULL_ANALYSIS_MODE=inventory 的启用授权（那是独立的人工决定）。",
    verdict,
    repos: measured.map((entry, index) => ({ repo: entry.comparison.repo, source: entry.source, processGatesPassed: entry.processGatesPassed, telemetry: entry.telemetry, statistics: verdict.repos[index] })),
  };
  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(args.out, `${json}\n`);
    console.log(`[measure-inventory-analysis] report written to ${args.out}`);
  } else {
    console.log(json);
  }
  process.exitCode = verdict.status === "passed" ? 0 : verdict.status === "failed" ? 1 : 2;
}

try {
  main();
} catch (error) {
  console.error(`[measure-inventory-analysis] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 3;
}
