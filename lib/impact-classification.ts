import { analysisNoiseKind } from "./analysis-target";
import { evidenceKind, isInfrastructureEvidence, isSchemaArtifact } from "./evidence";
import { behavioralChangePaths } from "./patch-scan";

/**
 * 增量影响分类（impact-v1）。规格《客户端增量分析与 Delta Merge Contract 设计》§8。
 *
 * 纯函数：输入一个窗口的变更文件和一份「路径 → 功能键」索引，输出每个文件的归宿和整个窗口的
 * 结论。客户端与服务端跑同一份实现、同一个规则版本，所以这里不能依赖数据库、时钟或随机数。
 *
 * 保守方向：拿不准就往重的一档靠。global_unbounded 与 unknown 的窗口只能全量重同步，
 * 扩大声明集不能解除；只有确定性证据（patch-scan、blob 相等）才能把文件降到无行为。
 * 唯一例外是分析目标之外的文件（迁移脚本、测试、文档、CI）：服务端不读它们，它们改了也不会
 * 改变账本，所以不需要任何证据就可以判为无行为变更。
 */

/** 分类结论与原因码的取值集合随这个版本变化。 */
export const IMPACT_RULES_VERSION = "impact-v1";

export type FileStatus = "modified" | "added" | "deleted" | "renamed";

interface FileIdentity {
  path: string;
  oldMode: string | null;
  newMode: string | null;
  oldBlobSha: string | null;
  newBlobSha: string | null;
}

/**
 * `git diff --raw -z` 清单里的一条记录。删除的文件 `path` 就是它原来的路径；只有重命名带两个路径，
 * 所以 `oldPath` 只在重命名时有值，类型上写不出别的搭配。
 */
export type ManifestEntry = FileIdentity & ({ status: "renamed"; oldPath: string } | { status: Exclude<FileStatus, "renamed">; oldPath: null });

/** 清单记录加上二进制判定（按 blob 内容）与补丁。 */
export type ChangedFile = ManifestEntry & { binary: boolean; patch: string | null };

/** 基线文件索引：证据路径 → 以它为证据的功能键。只应包含自动功能。 */
export type FileIndex = ReadonlyMap<string, readonly string[]>;

export type GlobalReason = "assembly_point" | "schema_migration" | "runtime_config" | "dependency_manifest" | "shared_module" | "symlink" | "submodule";
export type UnknownReason = "binary_content";
export type NoBehaviorReason = "document" | "comment_or_format_only" | "content_unchanged";
export type NoDetectedReason =
  | "test_code"
  | "ci_config"
  | "editor_or_vcs_config"
  | "static_asset"
  | "mode_change"
  | "schema_artifact"
  | "outside_analysis_target";
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
    // 只剩 ORM 模型与 schema 定义。迁移脚本（migrations/ 目录、.sql）已移出分析目标，
    // 2026-11-25 起按「已检测到、无行为变更」处理，见 classifyByNature。
    reason: "schema_migration",
    patterns: [
      /(?:^|\/)models?\//,
      /(?:^|\/)models?\.py$/,
      /(?:^|\/)(?:alembic|drizzle)\//,
      /\.prisma$/,
      /(?:^|\/)[^/]*\.entity\.ts$/,
      /(?:^|\/)(?:schema|schemas)\.(?:prisma|graphql|gql)$/,
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
/** §7.1 的契约：符号链接与子模块的变化一律全量重同步。 */
const SPECIAL_MODE_REASON: Readonly<Record<string, GlobalReason>> = { "120000": "symlink", "160000": "submodule" };
/** 没有任何 hunk 的补丁证明不了「无行为变化」：二进制，以及被 `-diff` 属性挡住的文本，git 都只给出 Binary files differ。 */
const HUNK_HEADER = /^@@ -\d+/m;
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

type ChangedBase = ChangedPaths;

function pathsOf(file: ChangedFile): ChangedBase {
  return { path: file.path, oldPath: file.oldPath, status: file.status };
}

const noBehavior = (base: ChangedBase, reason: NoBehaviorReason): FileImpact => ({ ...base, classification: "no_behavior", reason });
const noDetected = (base: ChangedBase, reason: NoDetectedReason): FileImpact => ({ ...base, classification: "no_detected_behavior_change", reason });

function binaryImpact(file: ChangedFile, base: ChangedBase): FileImpact {
  const knownAsset = (path: string) => /^(?:docs\/|[^/]*\.md$)/.test(path) || STATIC_ASSET.test(path);
  return (file.status === "renamed" ? [file.path, file.oldPath] : [file.path]).some(knownAsset) ? noDetected(base, "static_asset") : { ...base, classification: "unknown", reason: "binary_content" };
}

/** 内容没变的变更：纯重命名、仅模式变化。新增与删除总是算内容有变。 */
function unchangedContentImpact(file: ChangedFile, base: ChangedBase): FileImpact | null {
  const sameBlob = file.oldBlobSha !== null && file.oldBlobSha === file.newBlobSha;
  if (!sameBlob || file.status === "added" || file.status === "deleted") return null;
  if (file.status === "renamed") return { ...base, classification: "no_detected_behavior_change", reason: "pure_rename", reanchorsTo: file.oldPath };
  // 仅模式变化（如可执行位）：契约定为 no_detected_behavior_change，不是 unknown。
  return file.oldMode === file.newMode ? noBehavior(base, "content_unchanged") : noDetected(base, "mode_change");
}

/** 按路径所在层级归类，数组顺序即优先级。都不命中的是普通实现文件。 */
const PATH_TIERS: ReadonlyArray<{ matches: (path: string) => boolean; impact: (base: ChangedBase) => FileImpact }> = [
  { matches: (path) => evidenceKind(path) === "test", impact: (base) => noDetected(base, "test_code") },
  { matches: (path) => isInfrastructureEvidence(path) || CI_CONFIG.test(path), impact: (base) => noDetected(base, "ci_config") },
  { matches: (path) => EDITOR_OR_VCS_CONFIG.test(path), impact: (base) => noDetected(base, "editor_or_vcs_config") },
  { matches: (path) => STATIC_ASSET.test(path), impact: (base) => noDetected(base, "static_asset") },
  { matches: (path) => evidenceKind(path) === "document", impact: (base) => noBehavior(base, "document") },
  // 其余不在分析目标里的文件（构建和部署文件、生成的代码、第三方副本、示例和基准……）：
  // 服务端不读它们，里面发生什么都不会改变账本。清单有自己的全局规则（dependency_manifest），轮不到这里。
  { matches: (path) => analysisNoiseKind(path) !== null, impact: (base) => noDetected(base, "outside_analysis_target") },
];

/** 不依赖索引与补丁内容的归类；返回 null 表示要按实现文件处理。 */
function classifyByNature(file: ChangedFile): FileImpact | null {
  const base = pathsOf(file);
  // 迁移脚本已移出分析目标（2026-11-25）：服务端不读它、不拿它当证据，它里面发生什么都不会
  // 改变账本，不需要任何证据就可以判为无行为变更。所以先于二进制判定。唯一的例外是纯重命名，
  // 仍走下面的通用分支，带上重锚信息，引用它的旧锚点才能跟着文件走。ORM 模型代码不在此列。
  const schemaArtifact = isSchemaArtifact(file.path);
  if (file.binary && !schemaArtifact) return binaryImpact(file, base);
  const unchanged = unchangedContentImpact(file, base);
  if (unchanged) return unchanged;
  if (schemaArtifact) return noDetected(base, "schema_artifact");
  const tier = PATH_TIERS.find((candidate) => candidate.matches(file.path));
  return tier ? tier.impact(base) : null;
}

function lookupPaths(file: ChangedFile): string[] {
  if (file.status === "renamed") return [file.oldPath, file.path];
  return [file.path];
}

function featureKeysFor(paths: readonly string[], index: FileIndex): string[] {
  const keys = new Set<string>();
  for (const path of paths) for (const key of index.get(path) ?? []) keys.add(key);
  return [...keys].sort();
}

function implementationImpact(file: ChangedFile, index: FileIndex): FileImpact {
  const base = pathsOf(file);
  const hasHunk = file.patch !== null && HUNK_HEADER.test(file.patch);
  const behavioral = !hasHunk || behavioralChangePaths([{ path: file.path, status: file.status, patch: file.patch ?? "" }]).has(file.path);
  if (!behavioral) return { ...base, classification: "no_behavior", reason: "comment_or_format_only" };
  const directFeatureKeys = featureKeysFor(lookupPaths(file), index);
  return { ...base, classification: "direct", reason: directFeatureKeys.length > 0 ? "indexed_implementation" : "unindexed_implementation_file", directFeatureKeys };
}

/** 给一个变更文件定档。全局规则最先匹配，所以一个路径同时命中多行时取到的是最保守的一档。 */
export function classifyFile(file: ChangedFile, index: FileIndex): FileImpact {
  const base = pathsOf(file);
  const specialReason = SPECIAL_MODE_REASON[file.oldMode ?? ""] ?? SPECIAL_MODE_REASON[file.newMode ?? ""];
  const globalReason = specialReason ?? globalRuleFor(file.path) ?? (file.status === "renamed" ? globalRuleFor(file.oldPath) : null);
  if (globalReason) return { ...base, classification: "global_unbounded", reason: globalReason };
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
