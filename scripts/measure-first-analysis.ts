import "dotenv/config";
import { getRemoteAnalysisSources, analysisSliceBudgets } from "../lib/remote-analysis";
import { createSlicePlanner } from "../lib/slice-planner";
import { analyzeWithAI, type AnalysisResult } from "../lib/ai";
import { evidenceKind } from "../lib/evidence";
import { getBranchHead, getRepository, githubFetch, parseRepository } from "../lib/github";
import type { Evidence } from "../lib/types";

/**
 * 首分析覆盖率测量（「160KB 覆盖上限」立项证据，2026-11-08）。
 *
 * 对每个仓库跑真实的首分析前半段（切片规划器 + AI 提取），与 GitHub 全树对比：
 *   - 实现面（按 evidenceKind 分级口径）：文件数 / 字节
 *   - 窗口：规划器选中文件数 / 实际进 prompt 的字节
 *   - 产出：功能数 / 场景数 / 场景密度（场景每 cited KB）
 *   - 覆盖率：cited 实现文件（文件与字节两个口径）/ 实现面
 *   - 越界引用：AI 证据路径不在窗口内的条数（应为 0，顺带校验 assertEvidence 口径）
 *
 * 不建产品、不写库、不落计费（analyzeWithAI 无 billing 参数）；
 * 只消耗 AI 网关调用量与 GitHub API 配额。用法：
 *   tsx scripts/measure-first-analysis.ts [owner/name ...]   （缺省跑内置 5 仓库）
 */

const DEFAULT_REPOS = [
  "expressjs/express",
  "colinhacks/zod",
  "pallets/flask",
  "honojs/hono",
  "calcom/cal.com",
];

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

interface TreeEntry { path: string; type: string; size?: number }
interface GroundTruth { implFiles: number; implBytes: number; codeFiles: number; codeBytes: number; truncated: boolean }
interface RepoMetrics {
  repo: string;
  head: string;
  groundTruth: GroundTruth;
  window: { selectedFiles: number; windowBytes: number; windowLimitBytes: number; selectedCodeFiles: number; codeOfferedRatio: number };
  spec: { features: number; scenarios: number };
  coverage: {
    citedImplFiles: number;
    citedImplFilesRatio: number;
    citedImplBytes: number;
    citedImplBytesRatio: number;
    citedCodeFilesRatio: number;
    citedCodeBytes: number;
    citedCodeBytesRatio: number;
  };
  density: { scenariosPerCitedKB: number; extrapolatedScenariosAtFullCoverage: number };
  citedPaths: string[];
  invalidCitedPaths: number;
  error?: string;
}

function collectEvidence(result: AnalysisResult): Evidence[] {
  const items: Evidence[] = [...result.product.evidence];
  for (const feature of result.features) {
    for (const scenario of feature.scenarios) items.push(...scenario.evidence);
  }
  for (const change of result.changes) items.push(...change.evidence);
  return items;
}

export function computeMetrics(input: {
  repo: string;
  head: string;
  tree: TreeEntry[];
  treeTruncated: boolean;
  sourcePaths: string[];
  windowBytes: number;
  result: AnalysisResult;
}): RepoMetrics {
  const blobs = input.tree.filter((entry) => entry.type === "blob");
  const truncated = input.treeTruncated;
  const impl = blobs.filter((entry) => evidenceKind(entry.path) === "implementation" && typeof entry.size === "number");
  const code = impl.filter((entry) => CODE_EXTENSIONS.test(entry.path));
  const sizeByPath = new Map(blobs.map((entry) => [entry.path, entry.size ?? 0]));

  const cited = collectEvidence(input.result).map((item) => item.path);
  const citedSet = [...new Set(cited)];
  const citedImpl = citedSet.filter((path) => evidenceKind(path) === "implementation");
  const windowSet = new Set(input.sourcePaths);
  const invalidCitedPaths = citedSet.filter((path) => !windowSet.has(path)).length;

  const implBytes = impl.reduce((total, entry) => total + (entry.size ?? 0), 0);
  const codeBytes = code.reduce((total, entry) => total + (entry.size ?? 0), 0);
  const citedBytes = citedImpl.reduce((total, path) => total + (sizeByPath.get(path) ?? 0), 0);
  const citedCode = citedImpl.filter((path) => CODE_EXTENSIONS.test(path));
  const citedCodeBytes = citedCode.reduce((total, path) => total + (sizeByPath.get(path) ?? 0), 0);
  const sourceSet = new Set(input.sourcePaths);
  const selectedCode = input.sourcePaths.filter((path) => CODE_EXTENSIONS.test(path));
  const selectedCodeSet = new Set(selectedCode);
  const scenarios = input.result.features.reduce((total, feature) => total + feature.scenarios.length, 0);
  const citedKB = citedBytes / 1024;

  return {
    repo: input.repo,
    head: input.head,
    groundTruth: { implFiles: impl.length, implBytes, codeFiles: code.length, codeBytes, truncated },
    window: {
      selectedFiles: input.sourcePaths.length,
      windowBytes: input.windowBytes,
      windowLimitBytes: analysisSliceBudgets.maxAiContextSourceBytes,
      selectedCodeFiles: selectedCode.length,
      // 规划器供给率：窗口内代码文件 / 全仓代码文件——AI 看不到的文件不可能被引用
      codeOfferedRatio: code.length === 0 ? 0 : [...selectedCodeSet].filter((path) => sizeByPath.has(path)).length / code.length,
    },
    spec: { features: input.result.features.length, scenarios },
    coverage: {
      citedImplFiles: citedImpl.length,
      citedImplFilesRatio: impl.length === 0 ? 0 : citedImpl.length / impl.length,
      citedImplBytes: citedBytes,
      citedImplBytesRatio: implBytes === 0 ? 0 : citedBytes / implBytes,
      citedCodeFilesRatio: code.length === 0 ? 0 : citedCode.length / code.length,
      citedCodeBytes,
      citedCodeBytesRatio: codeBytes === 0 ? 0 : citedCodeBytes / codeBytes,
    },
    density: {
      scenariosPerCitedKB: citedKB === 0 ? 0 : scenarios / citedKB,
      extrapolatedScenariosAtFullCoverage: citedKB === 0 ? 0 : Math.round((codeBytes / 1024) * (scenarios / citedKB)),
    },
    citedPaths: citedImpl.sort(),
    invalidCitedPaths,
  };
}

async function measure(repoFullName: string, access: { token?: string }): Promise<RepoMetrics> {
  const repo = parseRepository(repoFullName);
  const full = await getRepository(repo, access);
  const head = await getBranchHead(full, access);
  const treePayload = await githubFetch(`/repos/${repo.owner}/${repo.name}/git/trees/${head}?recursive=1`, access) as { tree: TreeEntry[]; truncated?: boolean };

  const remote = await getRemoteAnalysisSources({
    product: { id: 0, slug: "measure", name: "measure" },
    repository: { owner: repo.owner, repo: repo.name, revision: head },
    access,
    provider: "github",
    scopeRoots: [{ path: "", role: "shared" as const }],
  }, { planner: createSlicePlanner({ now: () => Date.now() }), budgets: analysisSliceBudgets });
  const windowBytes = remote.sources.reduce((total, source) => total + Buffer.byteLength(source.content, "utf8"), 0);

  const result = await analyzeWithAI(remote.sources, {
    message: "首次分析覆盖率测量（无 diff）",
    files: [],
  });
  // 测量语境不中断：越界引用以 invalidCitedPaths 指标呈现（产品内由 assertEvidence 强制为 0）
  return computeMetrics({ repo: repoFullName, head, tree: treePayload.tree, treeTruncated: treePayload.truncated === true, sourcePaths: remote.sources.map((source) => source.path), windowBytes, result });
}

async function main() {
  const selectionOnly = process.argv.includes("--selection-only");
  const repos = process.argv.slice(2).filter((arg) => arg.includes("/"));
  const targets = repos.length > 0 ? repos : DEFAULT_REPOS;
  const access = { token: process.env.GITHUB_TOKEN };
  if (selectionOnly) {
    // 责任划分探针：只跑规划器，打印供给清单（不调 AI、不写任何东西）
    for (const repoFullName of targets) {
      const repo = parseRepository(repoFullName);
      const full = await getRepository(repo, access);
      const head = await getBranchHead(full, access);
      const remote = await getRemoteAnalysisSources({
        product: { id: 0, slug: "measure", name: "measure" },
        repository: { owner: repo.owner, repo: repo.name, revision: head },
        access,
        provider: "github",
        scopeRoots: [{ path: "", role: "shared" as const }],
      }, { planner: createSlicePlanner({ now: () => Date.now() }), budgets: analysisSliceBudgets });
      console.log(`\n[${repoFullName}] ${remote.sources.length} 文件 / ${Math.round(remote.sources.reduce((total, source) => total + Buffer.byteLength(source.content, "utf8"), 0) / 1024)}KB`);
      for (const source of remote.sources) console.log(`  ${source.path}`);
    }
    return;
  }
  const metrics: RepoMetrics[] = [];
  for (const repo of targets) {
    const startedAt = Date.now();
    try {
      const metric = await measure(repo, access);
      metrics.push(metric);
      console.log(`[ok] ${repo} (${Math.round((Date.now() - startedAt) / 1000)}s)`, JSON.stringify(metric));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metrics.push({ repo, head: "", groundTruth: { implFiles: 0, implBytes: 0, codeFiles: 0, codeBytes: 0, truncated: false }, window: { selectedFiles: 0, windowBytes: 0, windowLimitBytes: analysisSliceBudgets.maxAiContextSourceBytes, selectedCodeFiles: 0, codeOfferedRatio: 0 }, spec: { features: 0, scenarios: 0 }, coverage: { citedImplFiles: 0, citedImplFilesRatio: 0, citedImplBytes: 0, citedImplBytesRatio: 0, citedCodeFilesRatio: 0, citedCodeBytes: 0, citedCodeBytesRatio: 0 }, density: { scenariosPerCitedKB: 0, extrapolatedScenariosAtFullCoverage: 0 }, citedPaths: [], invalidCitedPaths: 0, error: message.slice(0, 300) });
      console.error(`[fail] ${repo}: ${message.slice(0, 300)}`);
    }
  }
  console.log("\n=== 汇总 ===");
  for (const metric of metrics) {
    if (metric.error) {
      console.log(`${metric.repo}: FAILED — ${metric.error}`);
      continue;
    }
    const percent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
    console.log(`${metric.repo}: 实现面 ${metric.groundTruth.implFiles} 文件/${Math.round(metric.groundTruth.implBytes / 1024)}KB（代码 ${Math.round(metric.groundTruth.codeBytes / 1024)}KB）→ 窗口 ${metric.window.selectedFiles} 文件/${Math.round(metric.window.windowBytes / 1024)}KB → 规格 ${metric.spec.features} 功能/${metric.spec.scenarios} 场景；覆盖 文件 ${percent(metric.coverage.citedImplFilesRatio)} 字节 ${percent(metric.coverage.citedImplBytesRatio)}；全量外推 ${metric.density.extrapolatedScenariosAtFullCoverage} 场景${metric.groundTruth.truncated ? "（树截断，实现面为下界）" : ""}`);
  }
}

if (process.argv[1]?.endsWith("measure-first-analysis.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
