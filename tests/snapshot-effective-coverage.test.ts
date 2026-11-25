import { describe, expect, it } from "vitest";
import type { AnalysisPartition } from "../lib/remote-analysis";
import { computeEffectiveSnapshotCoverage, isSnapshotDataFile, isSnapshotEffectiveImplementationPath } from "../lib/snapshot/effective-coverage";

function partition(path: string): AnalysisPartition {
  return { slice: { files: [{ path }] }, sources: [{ path, content: "1: source" }] } as AnalysisPartition;
}

describe("effective snapshot coverage", () => {
  it("classifies structured data separately without excluding source manifests and configuration", () => {
    expect(isSnapshotDataFile("data/atlas/tang/map.geojson")).toBe(true);
    expect(isSnapshotDataFile("data/users.json")).toBe(true);
    expect(isSnapshotDataFile("src/users.json")).toBe(false);
    expect(isSnapshotEffectiveImplementationPath("src/users.json")).toBe(true);
    expect(isSnapshotEffectiveImplementationPath("package.json")).toBe(true);
    expect(isSnapshotEffectiveImplementationPath("src/feature.ts")).toBe(true);
    expect(isSnapshotEffectiveImplementationPath("data/atlas/tang/map.geojson")).toBe(false);
    expect(isSnapshotEffectiveImplementationPath("data/users.json")).toBe(false);
    expect(isSnapshotEffectiveImplementationPath(".github/workflows/ci.yml")).toBe(false);
    expect(isSnapshotEffectiveImplementationPath("package-lock.json")).toBe(false);
    expect(isSnapshotEffectiveImplementationPath("Dockerfile")).toBe(true);
    expect(isSnapshotEffectiveImplementationPath("README.md")).toBe(false);
    expect(isSnapshotEffectiveImplementationPath("src/feature.test.ts")).toBe(false);
    // 迁移脚本已移出分析目标；ORM 模型定义仍在目标内。
    expect(isSnapshotEffectiveImplementationPath("migrations/001_init.sql")).toBe(false);
    expect(isSnapshotEffectiveImplementationPath("db/schema.sql")).toBe(false);
    expect(isSnapshotEffectiveImplementationPath("prisma/schema.prisma")).toBe(true);
  });

  it("counts only relevant files in numerator and denominator and never uses bytes", () => {
    const result = computeEffectiveSnapshotCoverage({
      partitions: [partition("src/app.ts"), partition("data/atlas/tang/map.geojson"), partition("package.json"), partition("migrations/001_init.sql")],
      implementationSurface: [
        { path: "src/app.ts", size: 10 },
        { path: "src/config.json", size: 20 },
        { path: "data/atlas/tang/map.geojson", size: 900_000 },
        { path: "data/users.json", size: 500_000 },
        { path: ".github/workflows/ci.yml", size: 100 },
        { path: "package-lock.json", size: 400_000 },
        { path: "package.json", size: 100 },
        { path: "migrations/001_init.sql", size: 900_000 },
        { path: "db/schema.sql", size: 50 },
      ],
    });
    expect(result.filesAssembled).toBe(2);
    expect(result.filesTotal).toBe(3);
    expect(result.ratio).toBeCloseTo(2 / 3);
    expect(result.dataFilesAssembled).toBe(1);
    expect(result.excludedDataFiles).toBe(2);
    expect(result.excludedOtherFiles).toBe(4);
    expect(result.rawFilesTotal).toBe(9);
  });

  it("returns an honest zero when no relevant files exist", () => {
    const result = computeEffectiveSnapshotCoverage({ partitions: [], implementationSurface: [{ path: "data/a.geojson", size: 999 }] });
    expect(result).toMatchObject({ filesAssembled: 0, filesTotal: 0, ratio: 0, excludedDataFiles: 1, excludedOtherFiles: 0 });
  });
});
