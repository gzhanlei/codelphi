import { evidenceKind, isInfrastructureEvidence } from "./evidence";
import type { FileImpact, FileStatus, WindowOutcome } from "./impact-classification";
import type { Anchor, BaselineIndex, StaleCount } from "./incremental-trial-metrics";

/**
 * 可用率试验里不碰 Git 的那一层（规格 §19.4）：把导出的账本索引解析成基线、判断哪些文件算实现源码、
 * 从真实历史里挑 Golden Repository 的冻结窗口、把结果渲染成报告。
 */

/** 导出文件里的一行：某个仓库一个发布版本的自动功能与证据锚点。 */
export interface LedgerLine {
  repositoryId: number;
  sha: string;
  versionId: number;
  features: ReadonlyArray<readonly [id: number, key: string]>;
  anchors: ReadonlyArray<readonly [featureKey: string, path: string, startLine: number | null, endLine: number | null]>;
}

export interface LedgerRelease {
  repositoryId: number;
  sha: string;
  versionId: number;
  baseline: BaselineIndex;
}

function baselineOf(line: LedgerLine): BaselineIndex {
  const featureKeys = line.features.map(([, key]) => key);
  const pathFeatures = new Map<string, string[]>();
  const featurePaths = new Map<string, string[]>();
  const anchors: Anchor[] = [];
  for (const [featureKey, path, startLine, endLine] of line.anchors) {
    anchors.push({ featureKey, path, startLine, endLine });
    pathFeatures.set(path, [...new Set([...(pathFeatures.get(path) ?? []), featureKey])].sort());
    featurePaths.set(featureKey, [...new Set([...(featurePaths.get(featureKey) ?? []), path])].sort());
  }
  return { featureKeys, pathFeatures, featurePaths, anchors };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** 形状校验只看会用到的东西：仓库号、提交号、功能表、锚点表。 */
function isLedgerLine(value: unknown): value is LedgerLine {
  if (!isRecord(value)) return false;
  const tuples = (list: unknown, width: number) => Array.isArray(list) && list.every((item) => Array.isArray(item) && item.length === width);
  return (
    typeof value.repositoryId === "number" &&
    typeof value.sha === "string" &&
    typeof value.versionId === "number" &&
    tuples(value.features, 2) &&
    tuples(value.anchors, 4)
  );
}

/** 按仓库归档，保持导出文件里的顺序（也就是发布顺序）。坏行直接报错并指出行号，不跳过。 */
export function parseLedger(jsonl: string): Map<number, LedgerRelease[]> {
  const byRepository = new Map<number, LedgerRelease[]>();
  const lines = jsonl.split("\n");
  for (const [index, text] of lines.entries()) {
    if (text.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`账本导出文件第 ${index + 1} 行不是合法的 JSON`);
    }
    if (!isLedgerLine(parsed)) throw new Error(`账本导出文件第 ${index + 1} 行的字段不完整`);
    const line: LedgerLine = parsed;
    const releases = byRepository.get(line.repositoryId) ?? [];
    releases.push({ repositoryId: line.repositoryId, sha: line.sha, versionId: line.versionId, baseline: baselineOf(line) });
    byRepository.set(line.repositoryId, releases);
  }
  return byRepository;
}

/** 全量分析要读的源码：实现层级的文件，不含 CI 与锁文件这类基础设施路径。 */
export function isImplementationSource(path: string): boolean {
  return evidenceKind(path) === "implementation" && !isInfrastructureEvidence(path);
}

/** 报告里每个窗口一行的文件记录：只留分类与定位需要的字段。 */
export interface TrialFileRow {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  classification: FileImpact["classification"];
  reason: string;
  directFeatureKeys: readonly string[];
}

export function toFileRows(files: readonly FileImpact[]): TrialFileRow[] {
  return files.map((entry) => {
    const directFeatureKeys = entry.classification === "direct" || entry.classification === "expanded_closed" ? entry.directFeatureKeys : [];
    return { path: entry.path, oldPath: entry.oldPath, status: entry.status, classification: entry.classification, reason: entry.reason, directFeatureKeys };
  });
}

/** 挑 Golden Repository 窗口时看的事实。 */
export interface GoldenCandidate {
  files: readonly TrialFileRow[];
  outcome: WindowOutcome;
  reanalyzedFeatures: number;
  newImplementationFiles: number;
  fastPath: StaleCount;
}

const hasReason = (reason: string) => (row: GoldenCandidate) => row.files.some((file) => file.reason === reason);
const everyFile = (test: (file: TrialFileRow) => boolean) => (row: GoldenCandidate) => row.files.length > 0 && row.files.every(test);

/**
 * 规格 §19.2 要求 Golden Repository 覆盖的情形。这里只列能从真实历史的分类结果里认出来的；
 * 认不出来的（force push、manual 冲突、相似度落在阈值附近、textconv 配置、功能合并、动态注册）
 * 要靠专门合成的夹具，不在真实历史里凑。
 */
export const GOLDEN_CATEGORIES: ReadonlyArray<{ id: string; covers: string; matches: (row: GoldenCandidate) => boolean }> = [
  { id: "shared_utility", covers: "跨文件共享工具", matches: hasReason("shared_module") },
  { id: "assembly_point", covers: "middleware/auth 与权限策略这类装配点", matches: hasReason("assembly_point") },
  { id: "schema_migration", covers: "schema/migration", matches: hasReason("schema_migration") },
  {
    id: "global_types_or_barrel",
    covers: "公共类型和 barrel export",
    matches: (row) => row.files.some((file) => file.reason === "shared_module" && /(?:^|\/)(?:index\.(?:ts|tsx)|types\.ts)$|\.d\.ts$/.test(file.path)),
  },
  { id: "new_feature", covers: "新功能", matches: (row) => row.outcome === "direct" && row.files.some((file) => file.status === "added" && file.classification === "direct") },
  { id: "feature_removed", covers: "功能删除", matches: (row) => row.outcome === "direct" && row.files.some((file) => file.status === "deleted" && file.directFeatureKeys.length > 0) },
  { id: "pure_rename", covers: "文件移动（内容不变的纯重命名）", matches: hasReason("pure_rename") },
  { id: "rename_with_content", covers: "rename + modify", matches: (row) => row.files.some((file) => file.status === "renamed" && file.reason !== "pure_rename") },
  { id: "tests_only", covers: "测试-only", matches: (row) => row.outcome === "no_detected_behavior_change" && everyFile((file) => file.reason === "test_code")(row) },
  { id: "readme_only", covers: "README-only", matches: (row) => row.outcome === "no_behavior" && everyFile((file) => file.reason === "document" && /\.md$/i.test(file.path))(row) },
  { id: "comment_only", covers: "仅注释、空白、格式化", matches: hasReason("comment_or_format_only") },
  {
    id: "unindexed_implementation",
    covers: "实现文件变更但不在任何证据锚上（证据覆盖召回边界）",
    matches: (row) => row.outcome === "direct" && row.reanalyzedFeatures > 0 && row.reanalyzedFeatures === row.newImplementationFiles,
  },
  { id: "comment_on_anchor", covers: "注释、空白、格式化改动恰好落在实现证据锚行上", matches: (row) => row.fastPath.nonBehavioralTouched > 0 },
  { id: "document_on_anchor", covers: "文档改动恰好落在文档证据锚行上", matches: (row) => row.fastPath.stale > 0 && everyFile((file) => file.reason === "document")(row) },
  { id: "shared_evidence_two_features", covers: "同一个变更文件被两个功能同时引用", matches: (row) => row.files.some((file) => file.directFeatureKeys.length >= 2) },
  { id: "unusual_path", covers: "路径含空格与非 ASCII 字符", matches: (row) => row.files.some((file) => /\s/.test(file.path) || /[^\x20-\x7e]/.test(file.path)) },
];

/** 每个情形取发布顺序里第一个命中的窗口。 */
export function selectGoldenWindows<T extends GoldenCandidate>(rows: readonly T[]): Record<string, T | null> {
  const selected = Object.fromEntries(GOLDEN_CATEGORIES.map((category) => [category.id, null])) as Record<string, T | null>;
  for (const row of rows) {
    for (const category of GOLDEN_CATEGORIES) {
      if (selected[category.id] === null && category.matches(row)) selected[category.id] = row;
    }
  }
  return selected;
}
