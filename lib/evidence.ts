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
