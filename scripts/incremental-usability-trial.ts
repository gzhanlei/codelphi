#!/usr/bin/env tsx
/**
 * 增量可用率试验（规格 §19.4，进入实施的 go/no-go）。
 *
 * 只跑分类器，不调模型，不走发布链。输入是生产库导出的账本索引和本机的完整克隆：
 * 同一仓库相邻两次发布之间是一个窗口，前一次发布的版本当基线。口径与阈值在跑之前
 * 写进了规格 §19.4，这里只是照着算，不替产品做判断。
 *
 * 用法：
 *   npx tsx scripts/incremental-usability-trial.ts \
 *     --ledger artifacts/incremental-usability-trial/ledger-index.jsonl \
 *     --primary 8 --repo 8=/path/to/clone --repo 11=/path/to/other-clone \
 *     --out artifacts/incremental-usability-trial/run
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyWindow } from "../lib/impact-classification";
import type { GlobalReason, WindowImpact, WindowOutcome } from "../lib/impact-classification";
import { countCommits, isAncestor, listCommits, readGitWindow, readTreeSizes } from "../lib/git-window";
import type { GitWindow } from "../lib/git-window";
import { aggregateWindows, measureWindow, simulateStale } from "../lib/incremental-trial-metrics";
import type { BaselineIndex, SizeSource, StalePoint, TrialSummary, WindowMetrics } from "../lib/incremental-trial-metrics";
import { GOLDEN_CATEGORIES, isImplementationSource, parseLedger, selectGoldenWindows, toFileRows } from "../lib/incremental-trial";
import type { GoldenCandidate, LedgerRelease, TrialFileRow } from "../lib/incremental-trial";

/** 规格 §19.4：两项都达标才算通过。 */
export const INCREMENTAL_WINDOW_THRESHOLD = 0.7;
export const TOKEN_SAVINGS_THRESHOLD = 0.5;

const FAST_PATHS: ReadonlySet<WindowOutcome> = new Set(["no_behavior", "no_detected_behavior_change"]);

export interface TrialOptions {
  ledgerPath: string;
  outDir: string;
  /** 主数据集，go/no-go 只看它。 */
  primaryRepositoryId: number;
  repositories: ReadonlyArray<{ repositoryId: number; repoRoot: string }>;
}

interface RepositoryOption {
  repositoryId: number;
  repoRoot: string;
}

function parseRepository(value: string): RepositoryOption {
  const match = /^(\d+)=(.+)$/.exec(value);
  if (!match) throw new Error(`--repo 要写成 <仓库号>=<本地克隆路径>，收到的是：${value}`);
  return { repositoryId: Number(match[1]), repoRoot: match[2] };
}

type Parsed = { ledgerPath?: string; outDir?: string; primaryRepositoryId?: number; repositories: RepositoryOption[] };

/** 每个参数都正好带一个取值。 */
const SETTERS: Readonly<Record<string, (target: Parsed, value: string) => void>> = {
  "--ledger": (target, value) => {
    target.ledgerPath = value;
  },
  "--out": (target, value) => {
    target.outDir = value;
  },
  "--primary": (target, value) => {
    target.primaryRepositoryId = Number(value);
  },
  "--repo": (target, value) => {
    target.repositories.push(parseRepository(value));
  },
};

function completeOptions(target: Parsed): TrialOptions {
  const { ledgerPath, outDir, primaryRepositoryId, repositories } = target;
  if (!ledgerPath || !outDir || primaryRepositoryId === undefined || !Number.isInteger(primaryRepositoryId)) {
    throw new Error("缺少参数：--ledger、--out、--primary 都要给，--primary 要是仓库号");
  }
  if (repositories.length === 0) throw new Error("缺少参数：至少要有一个 --repo <仓库号>=<本地克隆路径>");
  return { ledgerPath, outDir, primaryRepositoryId, repositories };
}

export function parseArgs(argv: readonly string[]): TrialOptions {
  const target: Parsed = { repositories: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const set = SETTERS[flag];
    if (!set) throw new Error(`不认识的参数：${flag}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${flag} 缺少取值`);
    set(target, value);
  }
  return completeOptions(target);
}

/** 报告里每个窗口一行的记录。非线性的窗口没有度量。 */
export interface TrialWindowRow {
  repositoryId: number;
  index: number;
  baseSha: string;
  headSha: string;
  linear: boolean;
  commits: number;
  files: TrialFileRow[];
  metrics: WindowMetrics | null;
  /** 窗口里每个提交单独当一个窗口时的归宿，按提交顺序。 */
  commitOutcomes: WindowOutcome[];
}

interface MeasuredWindow {
  row: TrialWindowRow;
  impact: WindowImpact;
  removedLines: GitWindow["removedLines"];
  /** 窗口终点那次发布的真实锚点，代表重分析或全量重同步之后的新证据。 */
  nextAnchors: BaselineIndex["anchors"];
}

export interface StaleSummary {
  fastPathWindows: number;
  /** 快速路径窗口每次新增的 stale 锚点数，及其占当时锚点数的比例。 */
  meanNewlyStale: number | null;
  meanNewlyStaleShare: number | null;
  maxStaleShare: number;
  finalStaleShare: number;
  finalAnchors: number;
  recoveredByReanalysis: number;
  recoveredByFullResync: number;
}

function isFastPath(outcome: WindowOutcome | undefined): boolean {
  return outcome !== undefined && FAST_PATHS.has(outcome);
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** `outcomes[index]` 是产生 `points[index]` 的那个窗口的归宿。 */
export function summarizeStale(points: readonly StalePoint[], outcomes: readonly WindowOutcome[]): StaleSummary {
  const fastPath = points.filter((_, index) => isFastPath(outcomes[index]));
  const last = points[points.length - 1];
  return {
    fastPathWindows: fastPath.length,
    meanNewlyStale: mean(fastPath.map((point) => point.newlyStale)),
    meanNewlyStaleShare: mean(fastPath.map((point) => (point.anchors === 0 ? 0 : point.newlyStale / point.anchors))),
    maxStaleShare: points.reduce((max, point) => Math.max(max, point.staleShare), 0),
    finalStaleShare: last?.staleShare ?? 0,
    finalAnchors: last?.anchors ?? 0,
    recoveredByReanalysis: points.reduce((sum, point) => sum + point.recoveredByReanalysis, 0),
    recoveredByFullResync: points.reduce((sum, point) => sum + point.recoveredByFullResync, 0),
  };
}

export interface Verdict {
  incrementalShare: number | null;
  tokenSavings: number | null;
  passes: boolean;
  reasons: string[];
}

export function verdictOf(summary: TrialSummary): Verdict {
  const share = summary.incrementalShare;
  const savings = summary.meanTokenSavings;
  const reasons: string[] = [];
  if (share === null || savings === null) reasons.push("没有任何可计量的窗口");
  if (share !== null && share < INCREMENTAL_WINDOW_THRESHOLD) reasons.push(`可增量窗口比例 ${percent(share)} 低于 ${percent(INCREMENTAL_WINDOW_THRESHOLD)}`);
  if (savings !== null && savings < TOKEN_SAVINGS_THRESHOLD) reasons.push(`预估 token 节省率 ${percent(savings)} 低于 ${percent(TOKEN_SAVINGS_THRESHOLD)}`);
  return { incrementalShare: share, tokenSavings: savings, passes: reasons.length === 0, reasons };
}

export interface LiftRow {
  reason: GlobalReason;
  /** 只因为这一条规则才全量的窗口数：这条规则一旦能封闭，它们立刻可以增量。 */
  alone: number;
  /** 与别的全局规则一起触发的窗口数：只封闭这一条救不回来。 */
  withOthers: number;
  /** 假如这条规则可以封闭，可增量窗口比例会变成多少。只算它单独触发的窗口。 */
  incrementalShareIfClosed: number | null;
}

/** 规格 §19.4 要报告回答的问题：把某条全局规则换成范围有限的声明式登记表，可用率能提高多少。 */
export function liftTable(rows: readonly TrialWindowRow[], summary: TrialSummary): LiftRow[] {
  const full = rows.filter((row) => row.metrics && !row.metrics.incremental);
  const reasons = new Set(full.flatMap((row) => [...(row.metrics?.globalReasons ?? [])]));
  return [...reasons].sort().map((reason) => {
    const triggered = full.filter((row) => row.metrics?.globalReasons.includes(reason));
    const alone = triggered.filter((row) => row.metrics?.globalReasons.length === 1).length;
    return {
      reason,
      alone,
      withOthers: triggered.length - alone,
      incrementalShareIfClosed: summary.windows === 0 ? null : (summary.incrementalWindows + alone) / summary.windows,
    };
  });
}

export interface RepositoryResult {
  repositoryId: number;
  windows: number;
  /** 只统计线性窗口。 */
  summary: TrialSummary;
  /** 窗口里每个提交单独当一个窗口来分类时，可增量的提交占比。 */
  commitWindows: number;
  commitIncrementalShare: number | null;
  stale: StaleSummary;
  nonLinearWindows: Array<{ index: number; baseSha: string; headSha: string }>;
  /** 每条全局规则触发全量的窗口数，以及它若能封闭时的可用率。 */
  lift: LiftRow[];
}

interface RepositoryRun {
  result: RepositoryResult;
  rows: TrialWindowRow[];
}

export interface GoldenPick {
  index: number;
  baseSha: string;
  headSha: string;
}

export interface TrialReport {
  thresholds: { incrementalWindow: number; tokenSavings: number };
  primaryRepositoryId: number;
  repositories: RepositoryResult[];
  golden: Record<string, GoldenPick | null>;
  verdict: Verdict;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function percentOrNull(value: number | null): string {
  return value === null ? "无法计量" : percent(value);
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string[] {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((cells) => `| ${cells.join(" | ")} |`)];
}

function verdictLines(verdict: Verdict): string[] {
  const headline = verdict.passes ? "**通过。**" : `**不通过。** ${verdict.reasons.join("；")}。`;
  const numbers = `可增量窗口比例 ${percentOrNull(verdict.incrementalShare)}，预估 token 节省率 ${percentOrNull(verdict.tokenSavings)}。`;
  return ["## 结论", "", headline, "", numbers];
}

function repositoryLines(report: TrialReport): string[] {
  return [
    "## 各仓库",
    "",
    ...table(
      ["仓库", "线性窗口", "非线性窗口", "可增量窗口比例", "平均 token 节省", "重分析功能占比（direct 窗口）", "增量超过全量的窗口", "按提交计的可增量比例"],
      report.repositories.map((result) => [
        String(result.repositoryId),
        String(result.summary.windows),
        String(result.nonLinearWindows.length),
        percentOrNull(result.summary.incrementalShare),
        percentOrNull(result.summary.meanTokenSavings),
        percentOrNull(result.summary.meanFeatureShareOfDirectWindows),
        String(result.summary.exceedsFullWindows),
        percentOrNull(result.commitIncrementalShare),
      ]),
    ),
  ];
}

function outcomeLines(report: TrialReport): string[] {
  return [
    "## 窗口归宿分布",
    "",
    ...table(
      ["仓库", "direct", "no_behavior", "no_detected_behavior_change", "global_unbounded", "unknown"],
      report.repositories.map((result) => {
        const counts = result.summary.outcomeCounts;
        return [String(result.repositoryId), String(counts.direct), String(counts.no_behavior), String(counts.no_detected_behavior_change), String(counts.global_unbounded), String(counts.unknown)];
      }),
    ),
  ];
}

function reasonLines(report: TrialReport): string[] {
  const rows: string[][] = [];
  for (const result of report.repositories) {
    const reasons = Object.entries(result.summary.globalReasonCounts).sort((a, b) => b[1] - a[1]);
    if (reasons.length === 0) rows.push([String(result.repositoryId), "（无）", "0"]);
    for (const [reason, count] of reasons) rows.push([String(result.repositoryId), reason, String(count)]);
  }
  return ["## 全量重同步的触发原因", "", ...table(["仓库", "原因", "窗口数"], rows)];
}

function staleLines(report: TrialReport): string[] {
  return [
    "## stale 锚点",
    "",
    ...table(
      ["仓库", "快速路径窗口数", "平均每次新增 stale", "平均每次新增占当时锚点的比例", "累计占比最高", "结束时占比", "靠重分析恢复", "靠全量重同步恢复"],
      report.repositories.map((result) => {
        const { stale } = result;
        return [
          String(result.repositoryId),
          String(stale.fastPathWindows),
          stale.meanNewlyStale === null ? "无" : stale.meanNewlyStale.toFixed(2),
          stale.meanNewlyStaleShare === null ? "无" : percent(stale.meanNewlyStaleShare),
          percent(stale.maxStaleShare),
          percent(stale.finalStaleShare),
          String(stale.recoveredByReanalysis),
          String(stale.recoveredByFullResync),
        ];
      }),
    ),
  ];
}

function liftLines(report: TrialReport): string[] {
  const cells: string[][] = [];
  for (const result of report.repositories) {
    if (result.lift.length === 0) cells.push([String(result.repositoryId), "（无）", "0", "0", percent(result.summary.incrementalShare ?? 0)]);
    for (const lift of result.lift) {
      cells.push([
        String(result.repositoryId),
        lift.reason,
        String(lift.alone),
        String(lift.withOthers),
        percentOrNull(lift.incrementalShareIfClosed),
      ]);
    }
  }
  return [
    "## 如果某条全局规则可以封闭",
    "",
    "只做算术，不改分类。可封闭的意思是：换成范围有限、可人工维护的声明式登记表之后，这条规则触发的窗口可以走增量。只算它单独触发的窗口，与其他规则一起触发的救不回来。token 节省率会随之上升，这里不估。",
    "",
    ...table(["仓库", "全局规则", "单独触发的窗口数", "与其他规则一起触发", "若能封闭，可增量窗口比例变为"], cells),
  ];
}

function nonLinearLines(report: TrialReport): string[] {
  const lines: string[] = [];
  for (const result of report.repositories) {
    for (const window of result.nonLinearWindows) lines.push(`- 仓库 ${result.repositoryId}，第 ${window.index} 个窗口：${short(window.baseSha)} → ${short(window.headSha)}`);
  }
  return lines.length === 0 ? [] : ["## 非线性窗口（不计入比例）", "", ...lines];
}

function goldenLines(report: TrialReport): string[] {
  const rows = GOLDEN_CATEGORIES.map((category) => {
    const pick = report.golden[category.id];
    return [category.id, category.covers, pick ? `第 ${pick.index} 个窗口，${short(pick.baseSha)} → ${short(pick.headSha)}` : "真实历史里没有找到，需要合成夹具"];
  });
  return ["## Golden Repository 的冻结窗口", "", "取自主数据集的发布顺序，每个情形取第一个命中的窗口。", "", ...table(["情形", "覆盖的内容", "窗口"], rows)];
}

export function renderReport(report: TrialReport): string {
  const intro = [
    "# 增量可用率试验报告",
    "",
    `主数据集：仓库 ${report.primaryRepositoryId}。阈值（跑之前写进规格 §19.4）：可增量窗口比例不低于 ${percent(report.thresholds.incrementalWindow)}，预估 token 节省率不低于 ${percent(report.thresholds.tokenSavings)}。`,
    "",
  ];
  const sections = [verdictLines(report.verdict), repositoryLines(report), outcomeLines(report), reasonLines(report), liftLines(report), staleLines(report), nonLinearLines(report), goldenLines(report)];
  return `${intro.join("\n")}${sections.map((section) => `${section.join("\n")}\n`).join("\n")}`;
}

async function implementationSizes(repoRoot: string, sha: string): Promise<SizeSource> {
  const sizes = await readTreeSizes(repoRoot, sha);
  let fullFiles = 0;
  let fullBytes = 0;
  for (const [path, bytes] of sizes) {
    if (!isImplementationSource(path)) continue;
    fullFiles += 1;
    fullBytes += bytes;
  }
  return { fullFiles, fullBytes, bytesOf: (path) => sizes.get(path) ?? 0 };
}

async function commitOutcomes(repoRoot: string, baseSha: string, headSha: string, baseline: BaselineIndex): Promise<WindowOutcome[]> {
  const outcomes: WindowOutcome[] = [];
  for (const commit of await listCommits(repoRoot, baseSha, headSha)) {
    outcomes.push(classifyWindow((await readGitWindow(repoRoot, `${commit}^`, commit)).files, baseline.pathFeatures).outcome);
  }
  return outcomes;
}

const FULL_RESYNC: WindowImpact = { outcome: "global_unbounded", files: [], globalReasons: [], directFeatureKeys: [], requiredFeatureKeys: [] };

async function measureBetween(repoRoot: string, repositoryId: number, base: LedgerRelease, head: LedgerRelease, index: number): Promise<MeasuredWindow> {
  const row: TrialWindowRow = { repositoryId, index, baseSha: base.sha, headSha: head.sha, linear: false, commits: 0, files: [], metrics: null, commitOutcomes: [] };
  // 历史被改写或发布顺序错乱：这个窗口只能全量重同步，不参与比例。
  if (!(await isAncestor(repoRoot, base.sha, head.sha))) return { row, impact: FULL_RESYNC, removedLines: new Map(), nextAnchors: head.baseline.anchors };
  const window = await readGitWindow(repoRoot, base.sha, head.sha);
  const impact = classifyWindow(window.files, base.baseline.pathFeatures);
  const metrics = measureWindow(base.baseline, impact, window.removedLines, await implementationSizes(repoRoot, head.sha));
  return {
    row: {
      ...row,
      linear: true,
      commits: await countCommits(repoRoot, base.sha, head.sha),
      files: toFileRows(impact.files),
      metrics,
      commitOutcomes: await commitOutcomes(repoRoot, base.sha, head.sha, base.baseline),
    },
    impact,
    removedLines: window.removedLines,
    nextAnchors: head.baseline.anchors,
  };
}

/** 一批单提交窗口里可增量的占比。没有提交时无法计量。 */
export function incrementalShare(outcomes: readonly WindowOutcome[]): number | null {
  return outcomes.length === 0 ? null : outcomes.filter((outcome) => outcome === "direct" || FAST_PATHS.has(outcome)).length / outcomes.length;
}

async function runRepository(option: RepositoryOption, releases: readonly LedgerRelease[]): Promise<RepositoryRun> {
  const measured: MeasuredWindow[] = [];
  for (const [index, base] of releases.slice(0, -1).entries()) {
    const head = releases[index + 1];
    if (base.sha !== head.sha) measured.push(await measureBetween(option.repoRoot, option.repositoryId, base, head, index));
  }
  const rows = measured.map((window) => window.row);
  const points = simulateStale(
    releases[0].baseline.anchors,
    measured.map((window) => ({ impact: window.impact, removedLines: window.removedLines, nextAnchors: window.nextAnchors })),
  );
  const commitOutcomesAll = rows.flatMap((row) => row.commitOutcomes);
  const summary = aggregateWindows(rows.flatMap((row) => (row.metrics ? [row.metrics] : [])));
  const result: RepositoryResult = {
    repositoryId: option.repositoryId,
    windows: rows.length,
    summary,
    commitWindows: commitOutcomesAll.length,
    commitIncrementalShare: incrementalShare(commitOutcomesAll),
    stale: summarizeStale(points, measured.map((window) => window.impact.outcome)),
    nonLinearWindows: rows.filter((row) => !row.linear).map(({ index, baseSha, headSha }) => ({ index, baseSha, headSha })),
    lift: liftTable(rows, summary),
  };
  return { rows, result };
}

/** Golden Repository 的冻结窗口取自主数据集：每个情形取发布顺序里第一个命中的窗口。 */
export function pickGolden(rows: readonly TrialWindowRow[]): Record<string, GoldenPick | null> {
  const candidates: Array<GoldenCandidate & GoldenPick> = rows.flatMap((row) =>
    row.metrics
      ? [{ index: row.index, baseSha: row.baseSha, headSha: row.headSha, files: row.files, outcome: row.metrics.outcome, reanalyzedFeatures: row.metrics.reanalyzedFeatures, newImplementationFiles: row.metrics.newImplementationFiles, fastPath: row.metrics.fastPath }]
      : [],
  );
  const picks = selectGoldenWindows(candidates);
  const toPick = (pick: GoldenPick): GoldenPick => ({ index: pick.index, baseSha: pick.baseSha, headSha: pick.headSha });
  return Object.fromEntries(GOLDEN_CATEGORIES.map((category) => [category.id, picks[category.id] ? toPick(picks[category.id] as GoldenPick) : null]));
}

/** 试验的全部编排：读账本、逐仓库逐窗口量、写报告。入口只负责解析参数和把报告打印出来。 */
export async function run(options: TrialOptions): Promise<TrialReport> {
  const ledger = parseLedger(await readFile(options.ledgerPath, "utf8"));
  const runs: RepositoryRun[] = [];
  for (const option of options.repositories) {
    const releases = ledger.get(option.repositoryId);
    if (!releases) throw new Error(`账本导出里没有仓库 ${option.repositoryId}`);
    runs.push(await runRepository(option, releases));
  }
  const primary = runs.find((candidate) => candidate.result.repositoryId === options.primaryRepositoryId);
  if (!primary) throw new Error("主数据集没有跑出来");
  const report: TrialReport = {
    thresholds: { incrementalWindow: INCREMENTAL_WINDOW_THRESHOLD, tokenSavings: TOKEN_SAVINGS_THRESHOLD },
    primaryRepositoryId: options.primaryRepositoryId,
    repositories: runs.map((candidate) => candidate.result),
    golden: pickGolden(primary.rows),
    verdict: verdictOf(primary.result.summary),
  };
  await mkdir(options.outDir, { recursive: true });
  await writeFile(join(options.outDir, "report.md"), renderReport(report));
  await writeFile(join(options.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(options.outDir, "windows.jsonl"), runs.flatMap((candidate) => candidate.rows.map((row) => JSON.stringify(row))).join("\n") + "\n");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(parseArgs(process.argv.slice(2)))
    .then((report) => {
      process.stdout.write(renderReport(report));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
