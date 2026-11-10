import { describe, expect, it } from "vitest";
import { buildFeatureConnections, type ScenarioEvidenceRow } from "../lib/feature-connections";

const row = (id: number, featureId: number, featureName: string, reference: string, paths: string[]): ScenarioEvidenceRow =>
  ({ id, featureId, featureName, reference, evidence: paths.map((path) => ({ path })) });

describe("feature connections (B3 确定性层)", () => {
  it("derives bidirectional connections from shared evidence files with justification", () => {
    const connections = buildFeatureConnections([
      row(1, 1, "统一登录", "HP-1", ["lib/auth.ts", "lib/session.ts"]),
      row(2, 1, "统一登录", "EC-1", ["lib/auth.ts"]),
      row(3, 2, "规格导出", "HP-1", ["lib/auth.ts", "lib/export.ts"]),
      row(4, 3, "独立功能", "HP-1", ["lib/solo.ts"]),
    ]);
    expect(connections).toHaveLength(2); // 独立功能无连接不入清单
    const login = connections.find((entry) => entry.featureName === "统一登录")!;
    expect(login.connections).toHaveLength(1);
    expect(login.connections[0].targetFeatureName).toBe("规格导出");
    // 共享文件按引用数排序：auth.ts 命中登录 2 场景 + 导出 1 场景
    expect(login.connections[0].sharedFiles[0]).toMatchObject({ path: "lib/auth.ts", sourceScenarios: ["EC-1", "HP-1"], targetScenarios: ["HP-1"] });
  });

  it("returns empty when no feature shares evidence files", () => {
    expect(buildFeatureConnections([row(1, 1, "A", "HP-1", ["a.ts"]), row(2, 2, "B", "HP-1", ["b.ts"])])).toEqual([]);
  });

  it("handles string-encoded evidence JSON", () => {
    const connections = buildFeatureConnections([
      { id: 1, featureId: 1, featureName: "A", reference: "HP-1", evidence: JSON.stringify([{ path: "shared.ts" }]) },
      { id: 2, featureId: 2, featureName: "B", reference: "HP-1", evidence: JSON.stringify([{ path: "shared.ts" }]) },
    ]);
    expect(connections).toHaveLength(2);
    expect(connections[0].connections[0].sharedFiles[0].path).toBe("shared.ts");
  });
});
