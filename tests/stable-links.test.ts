import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveScenarioByStableKey, resolveFeatureByStableKey } from "../lib/stable-links";

const execute = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("stable link resolution", () => {
  it("resolves a feature stable key through the latest spec version to the live feature id", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_features sf")) return [[{ name: "统一登录", specVersionId: 44 }]];
      if (sql.includes("FROM features f")) return [[{ id: 12 }]];
      return [[]];
    });
    await expect(resolveFeatureByStableKey(3, "统一登录", execute)).resolves.toBe(12);
    expect(execute.mock.calls[0][0]).toContain("ORDER BY sf.spec_version_id DESC");
    expect(execute.mock.calls[0][1]).toEqual(["统一登录", 3]);
  });

  it("returns null when the stable key never existed", async () => {
    execute.mockResolvedValue([[]]);
    await expect(resolveFeatureByStableKey(3, "missing", execute)).resolves.toBeNull();
  });

  it("returns null when the feature was retired from the live spec", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_features sf")) return [[{ name: "架构图", specVersionId: 44 }]];
      return [[]];
    });
    await expect(resolveFeatureByStableKey(3, "架构图", execute)).resolves.toBeNull();
  });

  it("resolves a scenario stable key to its live feature", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_features sf")) return [[{ name: "统一登录", specVersionId: 44 }]];
      if (sql.includes("FROM scenarios s")) return [[{ id: 12 }]];
      return [[]];
    });
    await expect(resolveScenarioByStableKey(3, "统一登录", "HP-1", execute)).resolves.toBe(12);
  });

  it("returns null when the scenario reference is unknown", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM spec_features sf")) return [[{ name: "统一登录", specVersionId: 44 }]];
      return [[]];
    });
    await expect(resolveScenarioByStableKey(3, "统一登录", "HP-99", execute)).resolves.toBeNull();
  });
});
