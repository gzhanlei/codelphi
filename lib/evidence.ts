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
