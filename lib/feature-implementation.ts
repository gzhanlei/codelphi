import { evidenceItems } from "./evidence";

export interface ImplementationFile {
  path: string;
  lines: number;
  references: string[];
  url?: string;
}

interface ImplementationEntry {
  references: Set<string>;
  ranges: Array<[number, number]>;
  url?: string;
}

function mergedLineCount(ranges: Array<[number, number]>): number {
  if (ranges.length === 0) return 0;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0];
  for (const [from, to] of sorted.slice(1)) {
    if (from > end + 1) {
      total += end - start + 1;
      [start, end] = [from, to];
    } else if (to > end) {
      end = to;
    }
  }
  return total + (end - start + 1);
}

/** 按实现文件聚合一组场景的证据：路径去重、行区间合并、场景编号归并；url 取数据层已装饰的第一个。 */
export function aggregateImplementationFiles(scenarios: Array<{ reference: string; evidence: unknown }>): ImplementationFile[] {
  const byPath = new Map<string, ImplementationEntry>();
  for (const scenario of scenarios) {
    for (const item of evidenceItems(scenario.evidence)) {
      if (!item.path) continue;
      const entry = byPath.get(item.path) ?? { references: new Set<string>(), ranges: [] };
      entry.references.add(scenario.reference);
      if (item.startLine && item.startLine > 0) {
        entry.ranges.push([item.startLine, item.endLine && item.endLine >= item.startLine ? item.endLine : item.startLine]);
      }
      entry.url ??= item.url;
      byPath.set(item.path, entry);
    }
  }
  return [...byPath.entries()]
    .map(([path, entry]) => ({ path, lines: mergedLineCount(entry.ranges), references: [...entry.references].sort(), url: entry.url }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
