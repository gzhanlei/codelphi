import type { Evidence } from "./types";

export function evidenceItems(value: unknown): Evidence[] {
  if (Array.isArray(value)) return value as Evidence[];
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as Evidence[] : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function evidenceLabel(item: Evidence) {
  return `${item.path}${item.startLine ? `:${item.startLine}` : ""}`;
}

export type EvidenceKind = "implementation" | "test" | "document";

const TEST_EVIDENCE = /(?:^|\/)(?:tests?\/|.*\.test\.|.*\.spec\.)/i;
const DOCUMENT_EVIDENCE = /\.md$|(?:^|\/)docs\//i;
/**
 * BM-8（benchmark bm1-incremental-blind-eval §3 F5）：CI/基础设施路径不承载产品行为——
 * 工作流、labeler、许可证、依赖锁文件上的变更不构成「运行时如此执行」的证据。
 * 不并入 evidenceKind（保持 B1 实现面分母与证据标签稳定），仅用于行为性判定收窄。
 */
const INFRASTRUCTURE_EVIDENCE = /(?:^|\/)\.github\/|(?:^|\/)\.gitlab-ci\.yml$|(?:^|\/)\.circleci\/|(?:^|\/)Jenkinsfile$|(?:^|\/)\.travis\.yml$|(?:^|\/)LICENSE(?:\.[^/]+)?$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|composer\.lock)$|(?:^|\/)[^/]*\.lock$/i;

export function isInfrastructureEvidence(path: string): boolean {
  return INFRASTRUCTURE_EVIDENCE.test(path);
}

/**
 * 证据强度分级：链接到 README/prompt 的条目只证明「文档这样要求」，
 * 不证明「运行时如此执行」——测试与文档证据必须和实现代码区分开。
 */
export function evidenceKind(path: string): EvidenceKind {
  if (TEST_EVIDENCE.test(path)) return "test";
  if (DOCUMENT_EVIDENCE.test(path)) return "document";
  return "implementation";
}

/**
 * BM-6/B2 口径：证据全部来自测试/文档（无任何实现代码）时，该场景描述的是
 * 「测试这样断言」而非「运行时如此执行」——展示层打「测试佐证」标、发布影响投影降权，
 * 但不落库删除（无法证伪的主张保留可见、交人工核实，与 spec-diff 证伪门禁同一哲学）。
 * 基础设施文件（CI/锁文件）在 evidenceKind 里仍算 implementation，保持可见不冒进。
 * 入参兼容三种形状：证据数组、JSON 字符串、以及带 .evidence 字段的场景对象
 * （behavior_changes 的 before/after JSON 即场景对象）。
 */
export function isTestOnlyEvidence(value: unknown): boolean {
  const items = evidenceArrayOf(value);
  return items.length > 0 && items.every((item) => evidenceKind(String((item as { path?: unknown }).path ?? "")) !== "implementation");
}

function evidenceArrayOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return evidenceItems(value);
  if (value && typeof value === "object" && "evidence" in value) return evidenceArrayOf((value as { evidence: unknown }).evidence);
  return [];
}
