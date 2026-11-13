import { describe, expect, it } from "vitest";
import { buildFeatureConnections, buildFileImpact, type ScenarioEvidenceRow } from "../lib/feature-connections";

const row = (id: number, featureId: number, featureName: string, reference: string, paths: string[]): ScenarioEvidenceRow =>
  ({ id, featureId, featureName, reference, evidence: paths.map((path) => ({ path })) });

const impactRow = (
  id: number,
  featureId: number,
  featureName: string,
  reference: string,
  paths: string[],
  extra: Partial<Pick<ScenarioEvidenceRow, "context" | "action" | "outcome" | "source">> = {},
): ScenarioEvidenceRow =>
  ({ id, featureId, featureName, reference, evidence: paths.map((path) => ({ path })), ...extra });

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

describe("buildFileImpact (文件反查受影响功能)", () => {
  it("groups matched scenarios by requested path then feature, with stableKey and receipts", () => {
    const impact = buildFileImpact(
      [
        impactRow(1, 1, "统一登录", "HP-1", ["lib/auth.ts", "lib/session.ts"], { context: "已登录", action: "访问设置页", outcome: "跳转", source: "manual" }),
        impactRow(2, 2, "规格导出", "EC-1", ["lib/auth.ts"], { context: "导出中", action: "点击导出", outcome: "下载文件", source: "generated" }),
        impactRow(3, 1, "统一登录", "EC-1", ["lib/session.ts"]),
        impactRow(4, 3, "独立功能", "HP-1", ["lib/solo.ts"]),
      ],
      ["lib/auth.ts"],
    );
    expect(impact).toHaveLength(1);
    expect(impact[0].path).toBe("lib/auth.ts");
    expect(impact[0].features).toHaveLength(2); // 独立功能不以该文件为证据，不出现
    const login = impact[0].features.find((feature) => feature.featureName === "统一登录")!;
    expect(login.stableKey).toBe("统一登录"); // 归一化稳定键：trim + 小写 + 空白折叠
    expect(login.scenarios).toHaveLength(1);
    expect(login.scenarios[0]).toMatchObject({ reference: "HP-1", context: "已登录", action: "访问设置页", outcome: "跳转", source: "manual" });
    expect(login.scenarioCount).toBe(1);
  });

  it("matches evidence paths exactly (lib/auth.ts must not match lib/auth.tsx)", () => {
    const impact = buildFileImpact(
      [
        impactRow(1, 1, "A", "HP-1", ["lib/auth.tsx"]),
        impactRow(2, 2, "B", "HP-1", ["lib/auth.ts"]),
      ],
      ["lib/auth.ts"],
    );
    expect(impact[0].features.map((feature) => feature.featureName)).toEqual(["B"]);
  });

  it("caps scenarios per feature at 10 but reports the true count", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      impactRow(index + 1, 1, "A", `HP-${index + 1}`, ["hot.ts"]),
    );
    const impact = buildFileImpact(rows, ["hot.ts"]);
    expect(impact[0].features[0].scenarios).toHaveLength(10);
    expect(impact[0].features[0].scenarioCount).toBe(12);
  });

  it("keeps requested path order, dedupes, and skips paths with no evidence", () => {
    const impact = buildFileImpact(
      [impactRow(1, 1, "A", "HP-1", ["a.ts"])],
      ["b.ts", "a.ts", "a.ts", "a.ts"],
    );
    expect(impact.map((entry) => entry.path)).toEqual(["a.ts"]); // b.ts 无证据不返回，a.ts 去重
  });

  it("parses string-encoded evidence JSON", () => {
    const impact = buildFileImpact(
      [{ id: 1, featureId: 1, featureName: "A", reference: "HP-1", evidence: JSON.stringify([{ path: "s.ts" }]) }],
      ["s.ts"],
    );
    expect(impact[0].features[0].scenarios[0].reference).toBe("HP-1");
  });

  it("returns an empty list for an empty path set", () => {
    expect(buildFileImpact([impactRow(1, 1, "A", "HP-1", ["a.ts"])], [])).toEqual([]);
  });
});
