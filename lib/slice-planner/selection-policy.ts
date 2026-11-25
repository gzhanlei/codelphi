import { nonRuntimePathPattern } from "../architecture/source";
import { isSchemaArtifact } from "../evidence";

/**
 * 切片选择策略：把「行为承载源码」与「噪声」（测试/文档/示例/基准/配置/CI/迁移脚本）区分开。
 *
 * 生产事故证据（docs/first-analysis-coverage-2026-11-08.md，2026-11-08 五仓库实测）：
 * 文件名信号启发式（manifest/entrypoint/route/auth）被噪声命名骗过——`test/app.route.js`
 * 撞上 route 信号、`bench/*.ts` 是代码扩展名兜底 service 信号——express 窗口无 lib/、
 * zod 无 src/、hono 仅 adapters/、cal.com 仅 configs。信号仍负责「想看什么」，
 * 本策略负责「不看什么」；两者正交，信号判定保持不变。
 */

export type SelectionNoiseKind = "test" | "doc" | "example" | "bench" | "config" | "ci" | "schema";

const DOC_BASENAMES = /^(?:readme|changelog|license|licence|contributing|code_of_conduct|security|notice|authors|contributors|governance|support|codeowners|pull_request_template)(?:\.[a-z]+)?$/i;
const EXAMPLE_DIR = /(?:^|\/)(?:examples?|samples?|demos?|tutorials?|cookbook)(?:\/|$)/i;
const BENCH_DIR = /(?:^|\/)(?:benchmarks?|bench(?:es)?|perf(?:ormance)?)(?:\/|$)/i;
const CI_DIR = /(?:^|\/)\.(?:github|circleci|gitlab|changeset|opencode|claude|vscode|idea|husky|cursor)(?:\/|$)/i;
const CONFIG_FILE = /\w+\.config\.(?:ts|mts|cts|js|mjs|cjs)$/i;
const CONFIG_BASENAME = /^(?:setupVitest|vitest\.workspace|jest\.config|karma\.conf|webpack\.common|tsconfig\.(?:base|node|web)|.*\.lintstagedrc|lint-staged\.config)\b/i;
const STORIES_FILE = /\.(?:stories|story)\.[a-z]+$/i;

/**
 * 构建清单白名单：profile 匹配（profileCandidates 按 paths 找 marker）与栈识别的依据，
 * 即使位于噪声目录或带噪声基名也不排除。readme/agents.md 不在白名单（那是文档）。
 */
const MANIFEST_PATTERN = /(?:^|\/)(?:package\.json|go\.mod|cargo\.toml|pom\.xml|composer\.json|requirements\.txt|pyproject\.toml|build\.gradle(?:\.kts)?|libs\.versions\.toml|androidmanifest\.xml|.*\.csproj|.*\.sln)$/i;

export function isSelectionManifest(path: string) {
  return MANIFEST_PATTERN.test(path);
}

/** 目录级噪声：整目录跳过（遍历不再进入）。隐藏目录（`.github` 等）按 CI 噪声处理。 */
export function isWalkNoiseDirectory(path: string) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  return segments.some((segment) => {
    if (segment.startsWith(".")) return true;
    // 迁移目录整目录不进：里面的脚本（含非 SQL 技术栈的迁移）都不在分析目标里。
    if (/^migrations?$/i.test(segment)) return true;
    return /^(?:tests?|__tests__|specs?|examples?|samples?|demos?|tutorials?|benchmarks?|bench(?:es)?|docs?|fixtures?|mocks?|__mocks__|stories?|snapshots?|generated)(?:$|\.)$/i.test(segment);
  });
}

/** 文件级噪声规则，顺序即优先级。清单永远不算噪声。 */
const NOISE_RULES: ReadonlyArray<{ kind: SelectionNoiseKind; matches: (path: string) => boolean }> = [
  // 迁移脚本不在分析目标里（2026-11-25）：迁移目录下的文件与 .sql 一律按 schema 噪声处理。
  { kind: "schema", matches: isSchemaArtifact },
  { kind: "doc", matches: (path) => DOC_BASENAMES.test(basename(path)) || /\.md$/i.test(path) || /(?:^|\/)docs?\//i.test(path) },
  { kind: "test", matches: (path) => nonRuntimePathPattern.test(path) || STORIES_FILE.test(path) },
  { kind: "example", matches: (path) => EXAMPLE_DIR.test(path) },
  { kind: "bench", matches: (path) => BENCH_DIR.test(path) },
  { kind: "ci", matches: (path) => CI_DIR.test(path) },
  { kind: "config", matches: (path) => CONFIG_FILE.test(path) || CONFIG_BASENAME.test(basename(path)) },
];

/** 文件级噪声分类；返回 null = 可入选窗口。清单永远返回 null。 */
export function selectionNoiseKind(path: string): SelectionNoiseKind | null {
  if (isSelectionManifest(path)) return null;
  return NOISE_RULES.find((rule) => rule.matches(path))?.kind ?? null;
}

function basename(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}
