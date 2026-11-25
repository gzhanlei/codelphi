import { isImplementationSurfaceFile, isInfrastructureEvidence } from "../evidence";
import type { AnalysisPartition } from "../remote-analysis";

const DIRECT_DATA_EXTENSIONS = new Set([".geojson", ".topojson", ".csv", ".tsv", ".ndjson", ".jsonl", ".parquet", ".avro", ".sqlite", ".db"]);
const STRUCTURED_DATA_EXTENSIONS = new Set([...DIRECT_DATA_EXTENSIONS, ".json", ".yaml", ".yml", ".xml"]);
const DATA_DIRECTORY = /(?:^|\/)(?:data|datasets?|fixtures|samples|mocks?|seeds?)(?:\/|$)/i;

function extension(path: string) {
  const name = path.split("/").pop() ?? path;
  return name.includes(".") ? `.${name.split(".").pop()!.toLowerCase()}` : "";
}

/** Structured data is disclosed separately rather than diluting source-code coverage. */
export function isSnapshotDataFile(path: string) {
  const ext = extension(path);
  if (DIRECT_DATA_EXTENSIONS.has(ext)) return true;
  return DATA_DIRECTORY.test(path) && STRUCTURED_DATA_EXTENSIONS.has(ext);
}

/** Files that can materially explain current product behavior or how to run/configure it. Migration scripts are out of the analysis target. */
export function isSnapshotEffectiveImplementationPath(path: string) {
  if (!isImplementationSurfaceFile(path)) return false;
  if (isInfrastructureEvidence(path)) return false;
  return !isSnapshotDataFile(path);
}

export interface SnapshotEffectiveCoverage {
  filesAssembled: number;
  filesTotal: number;
  ratio: number;
  dataFilesAssembled: number;
  excludedDataFiles: number;
  excludedOtherFiles: number;
  rawFilesTotal: number;
}

export function computeEffectiveSnapshotCoverage(input: {
  partitions: AnalysisPartition[];
  implementationSurface: Array<{ path: string; size: number }>;
}): SnapshotEffectiveCoverage {
  const assembledPaths = new Set(input.partitions.flatMap((partition) => partition.slice.files.map((file) => file.path)));
  const surfacePaths = new Set(input.implementationSurface.map((file) => file.path));
  const filesAssembled = [...assembledPaths].filter(isSnapshotEffectiveImplementationPath).length;
  const filesTotal = [...surfacePaths].filter(isSnapshotEffectiveImplementationPath).length;
  const dataFilesAssembled = [...assembledPaths].filter(isSnapshotDataFile).length;
  const excludedDataFiles = [...surfacePaths].filter(isSnapshotDataFile).length;
  return {
    filesAssembled,
    filesTotal,
    ratio: filesTotal === 0 ? 0 : filesAssembled / filesTotal,
    dataFilesAssembled,
    excludedDataFiles,
    excludedOtherFiles: Math.max(0, surfacePaths.size - filesTotal - excludedDataFiles),
    rawFilesTotal: surfacePaths.size,
  };
}
