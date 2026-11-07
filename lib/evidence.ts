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
 * 证据强度分级：链接到 README/prompt 的条目只证明「文档这样要求」，
 * 不证明「运行时如此执行」——测试与文档证据必须和实现代码区分开。
 */
export function evidenceKind(path: string): EvidenceKind {
  if (TEST_EVIDENCE.test(path)) return "test";
  if (DOCUMENT_EVIDENCE.test(path)) return "document";
  return "implementation";
}
