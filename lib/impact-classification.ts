import { evidenceKind, isInfrastructureEvidence } from "./evidence";
import { behavioralChangePaths } from "./patch-scan";

/**
 * 增量影响分类（impact-v1）。规格《客户端增量分析与 Delta Merge Contract 设计》§8。
 *
 * 纯函数：输入一个窗口的变更文件和一份「路径 → 功能键」索引，输出每个文件的归宿和整个窗口的
 * 结论。客户端与服务端跑同一份实现、同一个规则版本，所以这里不能依赖数据库、时钟或随机数。
 *
 * 保守方向：拿不准就往重的一档靠。global_unbounded 与 unknown 的窗口只能全量重同步，
 * 扩大声明集不能解除；只有确定性证据（patch-scan、blob 相等）才能把文件降到无行为。
 */

/** 分类结论与原因码的取值集合随这个版本变化。 */
export const IMPACT_RULES_VERSION = "impact-v1";

export type FileStatus = "modified" | "added" | "deleted" | "renamed";

/** 与 §7.1 的 `git diff --raw -z` 清单逐项对应的变更文件。 */
export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  oldMode: string | null;
  newMode: string | null;
  oldBlobSha: string | null;
  newBlobSha: string | null;
  binary: boolean;
  /** unified diff（`-U0`）；缺失时按行为变更处理。 */
  patch: string | null;
}

/** 基线文件索引：证据路径 → 以它为证据的功能键。只应包含自动功能。 */
export type FileIndex = ReadonlyMap<string, readonly string[]>;

export type GlobalReason = "assembly_point" | "schema_migration" | "runtime_config" | "dependency_manifest" | "shared_module";
export type UnknownReason = "binary_content" | "mode_only_change";
export type NoBehaviorReason = "document" | "comment_or_format_only";
export type NoDetectedReason = "test_code" | "ci_config" | "editor_or_vcs_config" | "static_asset";
export type DirectReason = "indexed_implementation" | "unindexed_implementation_file";

interface ChangedPaths {
  path: string;
  oldPath: string | null;
  status: FileStatus;
}

/** 分类与原因码成对出现：某个分类下写不出不属于它的原因。 */
export type FileImpact = ChangedPaths & (
  | { classification: "global_unbounded"; reason: GlobalReason }
  | { classification: "unknown"; reason: UnknownReason }
  | { classification: "no_behavior"; reason: NoBehaviorReason }
  | { classification: "no_detected_behavior_change"; reason: NoDetectedReason }
  | { classification: "no_detected_behavior_change"; reason: "pure_rename"; reanchorsTo: string }
  | { classification: "direct" | "expanded_closed"; reason: DirectReason; directFeatureKeys: readonly string[] }
);

export type WindowOutcome = "direct" | "no_behavior" | "no_detected_behavior_change" | "global_unbounded" | "unknown";

export interface WindowImpact {
  /** 窗口里最重的一档。`direct` 与 `expanded_closed` 都表示要做模型分析。 */
  outcome: WindowOutcome;
  files: readonly FileImpact[];
  /** 窗口被判定全量时，触发的全局规则（去重、排序）。 */
  globalReasons: readonly GlobalReason[];
  directFeatureKeys: readonly string[];
  /** 服务端要求重分析的功能键：direct ∪ expanded。impact-v1 没有 consumer index，所以等于 direct。 */
  requiredFeatureKeys: readonly string[];
}

const SCRIPT = "ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go";
const JS_TS = "ts|tsx|js|jsx|mjs|cjs|mts|cts";
/** 不含 tsx/jsx：同名的前端组件（如 Container）不是装配点。 */
const NON_JSX_SCRIPT = "ts|js|mjs|cjs|mts|cts|py|go";

/**
 * §8.3 表里「公共 utils」「barrel」「路由注册」这些类别必须落成路径模式，没落成模式的不能当作已覆盖。
 * 全局规则针对装配点而不是被装配的实现：路由处理函数、中间件函数体本身是普通文件，走 direct。
 */
const GLOBAL_RULES: ReadonlyArray<{ reason: GlobalReason; patterns: readonly RegExp[] }> = [
  {
    reason: "assembly_point",
    patterns: [
      // Next.js 的 middleware / proxy / instrumentation 只在仓库根或 src/ 下才是入口；lib/proxy.ts 是普通模块。
      new RegExp(`^src/(?:middleware|proxy|instrumentation|instrumentation-client)\\.(?:${JS_TS})$|^middleware\\.[^.]+$`),
      /(?:^|\/)middleware\/|(?:^|\/)middleware\.py$/,
      /(?:^|\/)app\/(?:[^/]+\/)*layout\.[^.]+$/,
      new RegExp(`(?:^|/)(?:registry|registries|container|injector|bootstrap|router|routes|urls)\\.(?:${NON_JSX_SCRIPT})$`),
      /(?:^|\/)(?:registry|registries|di|ioc)\//,
      /(?:^|\/)(?:main|wire|wire_gen)\.go$/,
      /(?:^|\/)(?:apps|admin|signals|wsgi|asgi|manage|celery)\.py$/,
    ],
  },
  {
    reason: "schema_migration",
    patterns: [
      /(?:^|\/)migrations?\//,
      /\.sql$/,
      /(?:^|\/)models?\//,
      /(?:^|\/)models?\.py$/,
      /(?:^|\/)(?:alembic|drizzle)\//,
      /\.prisma$/,
      /(?:^|\/)[^/]*\.entity\.ts$/,
      /(?:^|\/)(?:schema|schemas)\.(?:sql|prisma|graphql|gql)$/,
    ],
  },
  {
    reason: "runtime_config",
    patterns: [
      /(?:^|\/)\.env(?:\.[^/]*)?$/,
      /(?:^|\/)config\//,
      new RegExp(`(?:^|/)[^/]*\\.config\\.(?:${JS_TS}|json)$`),
      /(?:^|\/)tsconfig[^/]*\.json$/,
      new RegExp(`(?:^|/)(?:feature[-_]?flags?|flags)\\.(?:${SCRIPT}|json)$`),
      /(?:^|\/)(?:Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Procfile|\.nvmrc|\.node-version|\.python-version|\.tool-versions|vercel\.json|netlify\.toml|fly\.toml|render\.yaml)$/,
      /(?:^|\/)(?:k8s|kubernetes|helm|deploy|deployment)\//,
    ],
  },
  {
    reason: "dependency_manifest",
    patterns: [
      /(?:^|\/)package\.json$/,
      /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?|packages\.lock\.json)$/,
      /\.lock$/,
      /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|setup\.py|setup\.cfg|Pipfile|poetry\.lock|uv\.lock)$/,
      /(?:^|\/)(?:go\.mod|go\.sum|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|pubspec\.(?:yaml|lock)|mix\.exs|Package\.swift|Package\.resolved|Podfile(?:\.lock)?|flake\.lock|[^/]*\.csproj|[^/]*\.gemspec)$/,
    ],
  },
  {
    reason: "shared_module",
    patterns: [
      /(?:^|\/)(?:shared|common|utils?|helpers?)\//,
      // 文件名形式的共享模块只认源码扩展名，免得把 common-xxx.md 这类文档也判成全量。
      new RegExp(`(?:^|/)(?:shared|common|utils?|helpers?)[-.][^/]*\\.(?:${SCRIPT})$`),
      new RegExp(`(?:^|/)(?:utils?|helpers?)\\.(?:${SCRIPT})$|^[a-z0-9]+_(?:utils?|helpers?)\\.py$`),
      new RegExp(`(?:^|/)index\\.(?:${JS_TS})$`),
      /(?:^|\/)__init__\.py$/,
      // 只有顶层或一级目录下的才是全局类型定义；嵌在模块里的 types.ts 是普通实现文件。
      new RegExp(`^(?:[^/]+/)?(?:types|typings|interfaces|contracts)\\.(?:ts|py|go)$|^(?:[^/]+/)?(?:types|typings|interfaces|contracts)/`),
      /(?:^|\/)[^/]*\.d\.ts$/,
      new RegExp(`(?:^|/)(?:public[-_]api|api[-_]types|shared[-_]types)\\.(?:${SCRIPT})$`),
    ],
  },
];

const CI_CONFIG = /(?:^|\/)(?:Makefile|makefile|GNUmakefile)$|(?:^|\/)\.buildkite\/|(?:^|\/)azure-pipelines\.yml$|(?:^|\/)\.pre-commit-config\.ya?ml$|(?:^|\/)\.husky\/|(?:^|\/)lefthook\.ya?ml$|(?:^|\/)\.huskyrc(?:\.js)?$/;
const EDITOR_OR_VCS_CONFIG = /(?:^|\/)\.(?:gitignore|gitattributes|gitmodules|git-blame-ignore-revs|editorconfig|mailmap|npmrc|DS_Store)$|^\/\.(?:vscode|idea)\//;
const STATIC_ASSET = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|icns|bmp|tiff?|psd|pdf|mp3|mp4|m4a|aac|wav|ogg|opus|webm|mov|avi|mkv|ttf|otf|woff2?|eot)$/i;

const RANK: Record<FileImpact["classification"], number> = {
  no_behavior: 0,
  no_detected_behavior_change: 1,
  direct: 2,
  expanded_closed: 2,
  unknown: 3,
  global_unbounded: 4,
};
const OUTCOME_BY_RANK: readonly WindowOutcome[] = ["no_behavior", "no_detected_behavior_change", "direct", "unknown", "global_unbounded"];

function globalRuleFor(path: string): GlobalReason | null {
  for (const rule of GLOBAL_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(path))) return rule.reason;
  }
  return null;
}

/** 不依赖索引与补丁内容的归类；返回 null 表示要按实现文件处理。 */
function classifyByNature(file: ChangedFile): FileImpact | null {
  const base = { path: file.path, oldPath: file.oldPath, status: file.status };
  if (file.binary) {
    const asset = /^(?:docs\/|[^/]*\.md$)/.test(file.path) || STATIC_ASSET.test(file.path) || STATIC_ASSET.test(file.oldPath ?? "");
    return asset ? { ...base, classification: "no_detected_behavior_change", reason: "static_asset" } : { ...base, classification: "unknown", reason: "binary_content" };
  }
  const sameBlob = file.oldBlobSha !== null && file.oldBlobSha === file.newBlobSha;
  if (file.status === "renamed" && sameBlob) {
    return { ...base, classification: "no_detected_behavior_change", reason: "pure_rename", reanchorsTo: file.oldPath ?? file.path };
  }
  if (sameBlob && file.status !== "added" && file.status !== "deleted") {
    return file.oldMode === file.newMode
      ? { ...base, classification: "no_behavior", reason: "comment_or_format_only" }
      : { ...base, classification: "unknown", reason: "mode_only_change" };
  }
  const path = file.path || file.oldPath || "";
  if (evidenceKind(path) === "test") return { ...base, classification: "no_detected_behavior_change", reason: "test_code" };
  if (isInfrastructureEvidence(path) || CI_CONFIG.test(path)) return { ...base, classification: "no_detected_behavior_change", reason: "ci_config" };
  if (EDITOR_OR_VCS_CONFIG.test(path)) return { ...base, classification: "no_detected_behavior_change", reason: "editor_or_vcs_config" };
  if (STATIC_ASSET.test(path)) return { ...base, classification: "no_detected_behavior_change", reason: "static_asset" };
  if (evidenceKind(path) === "document") return { ...base, classification: "no_behavior", reason: "document" };
  return null;
}

function lookupPaths(file: ChangedFile): string[] {
  if (file.status === "deleted") return [file.oldPath ?? file.path];
  if (file.status === "renamed") return [file.oldPath ?? file.path, file.path];
  return [file.path];
}

function featureKeysFor(paths: readonly string[], index: FileIndex): string[] {
  const keys = new Set<string>();
  for (const path of paths) for (const key of index.get(path) ?? []) keys.add(key);
  return [...keys].sort();
}

function implementationImpact(file: ChangedFile, index: FileIndex): FileImpact {
  const base = { path: file.path, oldPath: file.oldPath, status: file.status };
  const behavioral = behavioralChangePaths([{ path: file.path, status: file.status, patch: file.patch ?? "" }]).has(file.path);
  if (!behavioral) return { ...base, classification: "no_behavior", reason: "comment_or_format_only" };
  const directFeatureKeys = featureKeysFor(lookupPaths(file), index);
  return { ...base, classification: "direct", reason: directFeatureKeys.length > 0 ? "indexed_implementation" : "unindexed_implementation_file", directFeatureKeys };
}

/** 给一个变更文件定档。全局规则最先匹配，所以一个路径同时命中多行时取到的是最保守的一档。 */
export function classifyFile(file: ChangedFile, index: FileIndex): FileImpact {
  const globalReason = globalRuleFor(file.path) ?? (file.oldPath ? globalRuleFor(file.oldPath) : null);
  if (globalReason) return { path: file.path, oldPath: file.oldPath, status: file.status, classification: "global_unbounded", reason: globalReason };
  return classifyByNature(file) ?? implementationImpact(file, index);
}

export function classifyWindow(files: readonly ChangedFile[], index: FileIndex): WindowImpact {
  const impacts = files.map((file) => classifyFile(file, index));
  const worst = impacts.reduce((rank, entry) => Math.max(rank, RANK[entry.classification]), 0);
  const globalReasons = new Set<GlobalReason>();
  const directFeatureKeys = new Set<string>();
  for (const entry of impacts) {
    if (entry.classification === "global_unbounded") globalReasons.add(entry.reason);
    if (entry.classification === "direct" || entry.classification === "expanded_closed") for (const key of entry.directFeatureKeys) directFeatureKeys.add(key);
  }
  const requiredFeatureKeys = [...directFeatureKeys].sort();
  return { outcome: OUTCOME_BY_RANK[worst], files: impacts, globalReasons: [...globalReasons].sort(), directFeatureKeys: requiredFeatureKeys, requiredFeatureKeys };
}
