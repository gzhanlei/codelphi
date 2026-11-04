import { describe, expect, it, vi } from "vitest";
import { githubCodeHostingAdapter } from "../lib/code-hosting";
import { resolveManualAnalysis } from "../lib/manual-analysis";

const defaultExecute = vi.fn();
const defaultAdapter = {
  getRepository: vi.fn(),
  getBranchHead: vi.fn(),
};
vi.mock("../lib/db", () => ({ getDb: () => ({ execute: defaultExecute }) }));
vi.mock("../lib/code-hosting", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/code-hosting")>(),
  getCodeHostingAdapter: vi.fn(() => defaultAdapter),
}));

const persisted = {
  id: 9,
  provider: "github" as const,
  owner: "gzhanlei",
  name: "radar",
  defaultBranch: "main",
  connectionId: 42,
  organizationId: 7,
};

type Execute = (sql: string, parameters: Array<string | number>) => Promise<unknown>;

function dependencies(rows: unknown[]) {
  const execute = vi.fn<Execute>(async () => [rows]);
  const adapter = {
    ...githubCodeHostingAdapter,
    getRepository: vi.fn(async () => ({ owner: "gzhanlei", name: "radar", defaultBranch: "develop" })),
    getBranchHead: vi.fn(async () => "sha-head"),
  };
  return { execute, adapter, getAdapter: vi.fn(() => adapter) };
}

describe("manual analysis resolution", () => {
  it("uses the persisted provider, organization and installation for API analysis", async () => {
    const { execute, adapter, getAdapter } = dependencies([persisted]);
    const result = await resolveManualAnalysis("radar", 7, { execute, getAdapter });
    expect(result).toEqual({ repositoryId: 9, afterSha: "sha-head" });
    expect(execute.mock.calls[0][1]).toEqual(["radar", 7]);
    expect(execute.mock.calls[0][0]).toContain("AND p.organization_id = ?");
    expect(getAdapter).toHaveBeenCalledWith("github");
    expect(adapter.getRepository).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), { connectionId: 42, organizationId: 7 });
    expect(adapter.getBranchHead).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: "develop" }), { connectionId: 42, organizationId: 7 });
  });

  it("uses the persisted workspace for CLI analysis without an organization argument", async () => {
    const { execute, adapter } = dependencies([persisted]);
    const result = await resolveManualAnalysis("radar", undefined, { execute, getAdapter: () => adapter });
    expect(result?.repositoryId).toBe(9);
    expect(execute.mock.calls[0][1]).toEqual(["radar"]);
    expect(execute.mock.calls[0][0]).not.toContain("AND p.organization_id = ?");
    expect(adapter.getBranchHead).toHaveBeenCalledWith(expect.anything(), { connectionId: 42, organizationId: 7 });
  });

  it("uses the default database and provider dependencies", async () => {
    defaultExecute.mockResolvedValue([[persisted]]);
    defaultAdapter.getRepository.mockResolvedValue({ owner: "gzhanlei", name: "radar", defaultBranch: "main" });
    defaultAdapter.getBranchHead.mockResolvedValue("sha-default");
    const result = await resolveManualAnalysis("radar", 7);
    expect(result).toEqual({ repositoryId: 9, afterSha: "sha-default" });
    expect(defaultAdapter.getBranchHead).toHaveBeenCalledWith(expect.anything(), { connectionId: 42, organizationId: 7 });
  });

  it("returns null when the product repository is not registered", async () => {
    const { execute } = dependencies([]);
    await expect(resolveManualAnalysis("missing", 7, { execute, getAdapter: () => githubCodeHostingAdapter })).resolves.toBeNull();
  });
});
