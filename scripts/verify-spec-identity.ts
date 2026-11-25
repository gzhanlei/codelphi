#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { SpecFeature } from "../lib/spec-diff";
import { compareDiffPairing } from "../lib/spec-diff";
import {
  SpecIdentityError,
  changeRowIdentity,
  emptyIdentityMaps,
  foldRegistry,
  planVersionIdentities,
  toVersionIdentities,
  type IdentityRegistry,
  type VersionIdentities,
  type VersionIdentityPlan,
} from "../lib/spec-identity";
import { identityInputsOf, type IdentityRows } from "../lib/spec-identity-store";
import { backfillRepository, type BackfillRepository, type BackfillSource, type RepositoryBackfillReport } from "./backfill-spec-identities";
import { pairingDifferences } from "./replay-spec-diff";

/**
 * 身份层的离线验收（规格《客户端增量分析与 Delta Merge Contract 设计》§20、§22）。
 *
 * 输入是生产账本的只读导出：每个规格版本一行，带功能、场景全文和变化行。不连数据库，什么都不写。
 * 对每个仓库做三件事：
 *   1. 回填演练：按回填脚本同一条规则走一遍版本链，报告会不会遇到算不出身份的版本（冲突）。
 *   2. 相邻版本对照：每一对相邻版本分别按名称键和按身份比对，结果必须逐项相同。
 *      身份和名称连续一致的真实历史，正是检验“按身份配对不改变现有结果”的数据。
 *   3. 变化行的身份：三处（本版、上一版、登记表）都找不到身份的变化行有几条。只报告，不设门槛。
 *
 * 用法：
 *   npx tsx scripts/verify-spec-identity.ts --ledger <导出文件> [--repository <仓库号>]... [--out <报告文件>]
 */

/** 导出文件里的一行：一个规格版本。证据数组不在里面，跨版本比对不读它。 */
export interface ExportedFeature {
  id: number;
  name: string;
  summary: string;
  parentKey: string | null;
  source: "generated" | "manual";
  position: number;
}

export interface ExportedScenario {
  id: number;
  featureId: number;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: string;
  step: number | null;
  source: "generated" | "manual";
}

export interface ExportedChange {
  id: number;
  entityType: string;
  kind: string;
  featureKey: string;
  featureName: string;
  scenarioReference: string;
  baseSpecVersionId: number | null;
}

export interface ExportedVersion {
  id: number;
  repositoryId: number;
  productId: number;
  sha: string;
  analysisRunId: number | null;
  baseSpecVersionId: number | null;
  features: ExportedFeature[];
  scenarios: ExportedScenario[];
  changes: ExportedChange[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function isVersion(value: unknown): value is ExportedVersion {
  return isRecord(value) && typeof value.id === "number" && typeof value.repositoryId === "number" && Array.isArray(value.features) && Array.isArray(value.scenarios) && Array.isArray(value.changes);
}

/** 按导出顺序读出每个版本。首行的头信息跳过。坏行直接报错并指出行号，不跳过。 */
export function parseLedgerExport(jsonl: string): ExportedVersion[] {
  const versions: ExportedVersion[] = [];
  jsonl.split("\n").forEach((text, index) => {
    if (text.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`导出文件第 ${index + 1} 行不是合法的 JSON`);
    }
    if (isRecord(parsed) && parsed.kind === "header") return;
    if (!isVersion(parsed)) throw new Error(`导出文件第 ${index + 1} 行不是版本记录`);
    versions.push(parsed);
  });
  return versions;
}

/** 给跨版本比对用的规格对象：功能带着它的场景，和当初落库时一样。证据是空的。 */
export function specOf(version: ExportedVersion): SpecFeature[] {
  const scenariosByFeature = new Map<number, ExportedScenario[]>();
  for (const scenario of version.scenarios) {
    const list = scenariosByFeature.get(scenario.featureId);
    if (list) list.push(scenario);
    else scenariosByFeature.set(scenario.featureId, [scenario]);
  }
  return version.features.map((feature) => ({
    name: feature.name,
    summary: feature.summary,
    parentKey: feature.parentKey,
    source: feature.source,
    scenarios: (scenariosByFeature.get(feature.id) ?? []).map((scenario) => ({
      reference: scenario.reference,
      context: scenario.context,
      action: scenario.action,
      outcome: scenario.outcome,
      category: scenario.category as SpecFeature["scenarios"][number]["category"],
      step: scenario.step,
      source: scenario.source,
      evidence: [],
    })),
  }));
}

/** 给回填用的行：只带定位和分配身份需要的列。 */
export function identityRowsOf(version: ExportedVersion): IdentityRows {
  return {
    features: version.features.map((feature) => ({ id: feature.id, name: feature.name, parentKey: feature.parentKey })),
    scenarios: version.scenarios.map((scenario) => ({ id: scenario.id, featureId: scenario.featureId, reference: scenario.reference })),
    changes: version.changes.map((change) => ({ id: change.id, featureKey: change.featureKey, scenarioReference: change.scenarioReference })),
  };
}

/** 把导出文件当成回填的数据源。仓库按第一次出现的顺序，版本按版本号从小到大。 */
export function fileBackfillSource(versions: readonly ExportedVersion[]): BackfillSource {
  const repositories = new Map<number, BackfillRepository>();
  for (const version of versions) {
    if (!repositories.has(version.repositoryId)) repositories.set(version.repositoryId, { repositoryId: version.repositoryId, productId: version.productId });
  }
  const byVersion = new Map(versions.map((version) => [version.id, version] as const));
  return {
    repositories: async (repositoryIds) => [...repositories.values()].filter((repository) => repositoryIds.length === 0 || repositoryIds.includes(repository.repositoryId)),
    versions: async (repositoryId) => versions.filter((version) => version.repositoryId === repositoryId).map((version) => version.id).sort((a, b) => a - b),
    rows: async (specVersionId) => {
      const version = byVersion.get(specVersionId);
      if (!version) throw new Error(`导出文件里没有版本 ${specVersionId}`);
      return identityRowsOf(version);
    },
  };
}

/** 报告里每个样例最多列几条。 */
const SAMPLE_LIMIT = 20;

export interface RepositoryVerification {
  repositoryId: number;
  /** 回填演练的报告，和回填脚本默认演练时给出的是同一份。 */
  backfill: RepositoryBackfillReport;
  /** 比对过的相邻版本对数。走到算不出身份的那一版就停，后面的不再比。 */
  pairs: number;
  /** 其中两边都带着身份的版本对数。身份是空的时候比对会退回名称键，那样的“相同”说明不了什么。 */
  pairsWithIdentities: number;
  pairsDiffering: number;
  /** 结果不同的地方，最多 SAMPLE_LIMIT 条。 */
  differences: string[];
  changeRows: number;
  /** 三处都找不到身份的变化行数。 */
  changeRowsWithoutIdentity: number;
  unresolvedSamples: string[];
}

export interface VerificationReport {
  repositories: RepositoryVerification[];
  /** 每个仓库都算得出身份，并且每一对相邻版本的两种配对结果逐项相同。 */
  passes: boolean;
}

interface Walk {
  pairs: number;
  pairsWithIdentities: number;
  pairsDiffering: number;
  differences: string[];
  changeRows: number;
  changeRowsWithoutIdentity: number;
  unresolvedSamples: string[];
}

const describeChange = (change: ExportedChange) => `${change.kind}:${change.entityType} ${change.featureKey}${change.scenarioReference ? ` ${change.scenarioReference}` : ""}`;

/** 两边的功能身份都是空的比对说明不了什么：那时比对会退回名称键。 */
const carriesIdentities = (identities: VersionIdentities) => identities.features.size > 0;

/** 一对相邻版本的两种配对对照。 */
function comparePair(
  before: ExportedVersion,
  current: ExportedVersion,
  beforeIdentities: VersionIdentities,
  afterIdentities: VersionIdentities,
  compare: PairingComparison,
): { bothCarryIdentities: boolean; same: boolean; differences: string[] } {
  const comparison = compare(specOf(before), specOf(current), { identities: { before: beforeIdentities.features, after: afterIdentities.features } });
  const pair = `v${before.id} → v${current.id}`;
  const lines = comparison.same ? [] : pairingDifferences(comparison).map((difference) => `${pair}：${difference}`);
  return {
    bothCarryIdentities: carriesIdentities(beforeIdentities) && carriesIdentities(afterIdentities),
    same: comparison.same,
    // 结果不同但逐行的清单一样时，差别在被保留的原文里。也要说一声，不能什么都不留。
    differences: comparison.same || lines.length > 0 ? lines : [`${pair}：两种配对的结果不同，但逐行的变化和折叠清单一样`],
  };
}

/** 给一个版本的每条变化记录找身份，数出三处都找不到的。 */
function unresolvedChanges(changes: readonly ExportedChange[], plan: VersionIdentityPlan, previous: VersionIdentities, registry: IdentityRegistry): string[] {
  return changes
    .filter((change) => {
      const identity = changeRowIdentity({ featureKey: change.featureKey, scenarioReference: change.scenarioReference }, plan, previous, registry);
      return identity.featureIdentityKey === null && identity.scenarioIdentityKey === null;
    })
    .map(describeChange);
}

/** 两种配对的对照函数。验收时用真实的 compareDiffPairing；测试可以换一个。 */
type PairingComparison = typeof compareDiffPairing;

/**
 * 沿着版本链走一遍，和回填用的是同一条规则。边走边做两件事：
 * 相邻版本的两种配对对照；给这一版的每条变化记录找身份。
 * 走到算不出身份的那一版就停，后面的不再比。原因在回填演练的报告里。
 */
function walkChain(chain: readonly ExportedVersion[], compare: PairingComparison): Walk {
  const walk: Walk = { pairs: 0, pairsWithIdentities: 0, pairsDiffering: 0, differences: [], changeRows: 0, changeRowsWithoutIdentity: 0, unresolvedSamples: [] };
  let registry: IdentityRegistry = emptyIdentityMaps();
  let before: ExportedVersion | null = null;
  let beforeIdentities: VersionIdentities = emptyIdentityMaps();
  for (const current of chain) {
    let plan: VersionIdentityPlan;
    try {
      plan = planVersionIdentities({ features: identityInputsOf(identityRowsOf(current)), previous: beforeIdentities, registry });
    } catch (error) {
      if (!(error instanceof SpecIdentityError)) throw error;
      break;
    }
    const currentIdentities = toVersionIdentities(plan);
    if (before !== null) {
      walk.pairs += 1;
      const pair = comparePair(before, current, beforeIdentities, currentIdentities, compare);
      if (pair.bothCarryIdentities) walk.pairsWithIdentities += 1;
      if (!pair.same) {
        walk.pairsDiffering += 1;
        walk.differences.push(...pair.differences);
      }
    }
    const unresolved = unresolvedChanges(current.changes, plan, beforeIdentities, registry);
    walk.changeRows += current.changes.length;
    walk.changeRowsWithoutIdentity += unresolved.length;
    walk.unresolvedSamples.push(...unresolved);
    registry = foldRegistry(registry, plan);
    beforeIdentities = currentIdentities;
    before = current;
  }
  return { ...walk, differences: walk.differences.slice(0, SAMPLE_LIMIT), unresolvedSamples: walk.unresolvedSamples.slice(0, SAMPLE_LIMIT) };
}

export interface VerifyLedgerOptions {
  repositoryIds?: readonly number[];
  /** 两种配对的对照函数。默认是真实的那个，测试可以换。 */
  compare?: PairingComparison;
}

/** 在一份导出上验收。不连数据库，不写文件。 */
export async function verifyLedger(versions: readonly ExportedVersion[], options: VerifyLedgerOptions = {}): Promise<VerificationReport> {
  const compare = options.compare ?? compareDiffPairing;
  const source = fileBackfillSource(versions);
  const repositories = await source.repositories(options.repositoryIds ?? []);
  const results: RepositoryVerification[] = [];
  for (const repository of repositories) {
    const chain = versions.filter((version) => version.repositoryId === repository.repositoryId).sort((a, b) => a.id - b.id);
    const [backfill, walk] = await Promise.all([backfillRepository({ repository, source }), Promise.resolve(walkChain(chain, compare))]);
    results.push({ repositoryId: repository.repositoryId, backfill, ...walk });
  }
  return { repositories: results, passes: results.length > 0 && results.every((result) => passes(result)) };
}

function passes(result: RepositoryVerification): boolean {
  return result.backfill.conflict === null && result.pairsDiffering === 0 && result.pairs === result.pairsWithIdentities;
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string[] {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((cells) => `| ${cells.join(" | ")} |`)];
}

function verdictLines(report: VerificationReport): string[] {
  // 导出里一个版本都没有，也算不通过：那样的话“每一对都相同”是空话。
  if (report.repositories.length === 0) return ["**不通过。** 导出里没有可以验收的版本。"];
  if (report.passes) return [`**通过。** ${report.repositories.length} 个仓库都算得出身份，每一对相邻版本按名称键和按身份比对的结果逐项相同。`];
  const failed = report.repositories.filter((result) => !passes(result)).length;
  return [`**不通过。** ${failed} 个仓库有问题，见下面的冲突和差异。`];
}

function repositoryLines(report: VerificationReport): string[] {
  return [
    "## 各仓库",
    "",
    ...table(
      ["仓库", "版本", "功能行", "场景行", "新建功能身份", "新建场景身份", "恢复功能", "退休功能", "相邻版本对", "其中两边都有身份", "结果不同", "变化行", "无身份的变化行", "冲突"],
      report.repositories.map((result) => {
        const { backfill } = result;
        return [
          String(result.repositoryId),
          String(backfill.versions),
          String(backfill.featureRows),
          String(backfill.scenarioRows),
          String(backfill.mintedFeatures),
          String(backfill.mintedScenarios),
          String(backfill.restoredFeatures),
          String(backfill.retiredFeatures),
          String(result.pairs),
          String(result.pairsWithIdentities),
          String(result.pairsDiffering),
          String(result.changeRows),
          String(result.changeRowsWithoutIdentity),
          backfill.conflict === null ? "无" : "有",
        ];
      }),
    ),
  ];
}

/** 有问题才出现的几节：冲突、两种配对结果不同、没带着身份比的版本对、找不到身份的变化行。 */
function problemSections(report: VerificationReport): string[][] {
  const section = (heading: string, intro: readonly string[], lines: readonly string[]) => (lines.length === 0 ? [] : [heading, "", ...intro, ...lines]);
  const sections: string[][] = [];
  const conflicts = report.repositories.flatMap((result) => (result.backfill.conflict === null ? [] : [`- 仓库 ${result.repositoryId}：${result.backfill.conflict}`]));
  sections.push(section("## 回填演练遇到的冲突", [], conflicts));
  const differences = report.repositories.flatMap((result) => result.differences.map((difference) => `- 仓库 ${result.repositoryId}，${difference}`));
  sections.push(section("## 相邻版本两种配对结果不同的地方", [], differences));
  const withoutIdentities = report.repositories.filter((result) => result.pairs !== result.pairsWithIdentities);
  sections.push(
    section(
      "## 没有带着身份比的相邻版本",
      ["这些版本对里至少有一边没有功能身份，比对会退回名称键，说明不了按身份配对的结果：", ""],
      withoutIdentities.map((result) => `- 仓库 ${result.repositoryId}：${result.pairs} 对里有 ${result.pairs - result.pairsWithIdentities} 对`),
    ),
  );
  const unresolved = report.repositories.flatMap((result) => result.unresolvedSamples.map((sample) => `- 仓库 ${result.repositoryId}：${sample}`));
  sections.push(
    section(
      "## 找不到身份的变化行",
      ["这样的行在它所属的版本、上一版和登记表里都没有对应的条目，多半是被折叠掉的变体名。身份留空，不猜。每个仓库最多列几条：", ""],
      unresolved,
    ),
  );
  return sections.filter((lines) => lines.length > 0);
}

export function renderReport(report: VerificationReport): string {
  const sections = [["# 身份层离线验收", "", ...verdictLines(report), ""], repositoryLines(report), ...problemSections(report)];
  return `${sections.map((section) => `${section.join("\n")}\n`).join("\n")}`;
}

export interface VerifyOptions {
  ledgerPath: string;
  /** 只验收这些仓库。不给就全部验收。 */
  repositoryIds?: readonly number[];
  /** 给了就把报告写到这里。 */
  reportPath?: string;
}

/** 测试注入的对照函数；生产验收不给，用真实的。 */
export type { PairingComparison };

/** 参数的取值：有内容，且不是下一个开关。 */
const isValue = (value: string | undefined): value is string => value !== undefined && !value.startsWith("--");

export function parseArgs(argv: readonly string[]): VerifyOptions {
  let ledgerPath: string | undefined;
  let reportPath: string | undefined;
  const repositoryIds: number[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--ledger") ledgerPath = value;
    else if (flag === "--out") reportPath = value;
    else if (flag === "--repository") {
      if (!isValue(value) || !/^\d+$/.test(value)) throw new Error(`--repository 要填仓库号，收到的是：${value}`);
      repositoryIds.push(Number(value));
    } else throw new Error(`不认识的参数：${flag}。用法：--ledger <导出文件> [--repository <仓库号>]... [--out <报告文件>]`);
    if (!isValue(value)) throw new Error(`参数 ${flag} 缺少取值`);
  }
  if (!ledgerPath) throw new Error("缺少参数：--ledger <导出文件>");
  return { ledgerPath, repositoryIds, reportPath };
}

/** 读导出文件、验收、按需写报告。入口只负责解析参数和把报告打印出来。 */
export async function run(options: VerifyOptions): Promise<VerificationReport> {
  const report = await verifyLedger(parseLedgerExport(await readFile(options.ledgerPath, "utf8")), { repositoryIds: options.repositoryIds ?? [] });
  if (options.reportPath) {
    await mkdir(dirname(options.reportPath), { recursive: true });
    await writeFile(options.reportPath, renderReport(report));
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(parseArgs(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(renderReport(report));
      if (!report.passes) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
