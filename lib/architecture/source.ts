import type { ArchitectureEvidence, NodeFact } from "./facts";
import type { ArchitectureSignal } from "./signals";

export interface ArchitectureSource {
  path: string;
  content: string;
}

function numberedLine(line: string, index: number) {
  const match = line.match(/^\s*(\d+):\s?/);
  return match ? Number(match[1]) : index + 1;
}

export function findArchitectureEvidence(source: ArchitectureSource, markers: string[], detector: string, lineFilter?: (line: string) => boolean): ArchitectureEvidence | undefined {
  const lines = source.content.split("\n");
  const matchesMarkers = (line: string) => markers.length === 0 || markers.some((marker) => line.toLowerCase().includes(marker.toLowerCase()));
  const index = lines.findIndex((line) => matchesMarkers(line) && (lineFilter === undefined || lineFilter(line)));
  if (index < 0) return undefined;
  return { path: source.path, line: numberedLine(lines[index], index), detector };
}

export function architectureRuntimeSources(node: NodeFact, sources: ArchitectureSource[]) {
  const ownedPaths = node.sourcePaths === undefined ? [] : node.sourcePaths;
  const paths = new Set([...ownedPaths, ...node.evidence.map((item) => item.path)]);
  return sources.filter((source) => paths.has(source.path));
}

export function signalIdsForPaths(signals: ArchitectureSignal[], paths: Iterable<string>) {
  const accepted = new Set(paths);
  return signals.filter((signal) => accepted.has(signal.evidence.path)).map((signal) => signal.id).sort();
}

export function uniqueEvidence(evidence: ArchitectureEvidence[]) {
  const values = new Map(evidence.map((item) => [`${item.path}:${item.line}:${item.detector}`, item]));
  return [...values.values()].sort((a, b) => `${a.path}:${a.line}:${a.detector}`.localeCompare(`${b.path}:${b.line}:${b.detector}`));
}
