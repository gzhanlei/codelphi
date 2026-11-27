import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { verifyApiKey, execute } = vi.hoisted(() => ({ verifyApiKey: vi.fn(), execute: vi.fn() }));

vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));
vi.mock("@/lib/mcp/api-keys", () => ({ verifyApiKey }));

const { GET } = await import("../app/api/client-analysis/context/route");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const rows = [
  { id: 1, slug: "acme-api", name: "Acme API", analysisExecutor: "client", repositoryId: 57, provider: "github", host: "github.com", owner: "acme", repositoryName: "api", currentVersionId: 32, sourceRoots: [{ path: "apps/api", role: "api" }] },
  // 库里存了读不出来的东西（旧版本写坏的）：照常返回，源码根目录按没配置算。
  { id: 2, slug: "local-notes", name: "Local Notes", analysisExecutor: "client", repositoryId: 58, provider: "local", host: null, owner: "local-product-2", repositoryName: "notes", currentVersionId: 31, sourceRoots: "garbage" },
  { id: 3, slug: "hosted", name: "Hosted", analysisExecutor: "server", repositoryId: null, provider: null, host: null, owner: null, repositoryName: null, currentVersionId: null, sourceRoots: null },
];

const get = (key?: string) => GET(new NextRequest("http://localhost/api/client-analysis/context", { headers: key ? { authorization: `Bearer ${key}` } : {} }));

beforeEach(() => {
  vi.clearAllMocks();
  verifyApiKey.mockResolvedValue({ keyId: 7, organizationId: 2, scope: "snapshot_write" });
  execute.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT name FROM organizations")) return [[{ name: "Acme" }], []];
    if (sql.includes("FROM products p LEFT JOIN repositories")) return [rows, []];
    if (sql.includes("SELECT id, sha FROM spec_versions")) return [[{ id: 31, sha: SHA_A }, { id: 32, sha: SHA_B }], []];
    throw new Error(`unrouted sql: ${sql}`);
  });
});

describe("GET /api/client-analysis/context", () => {
  it("returns 401 without a valid key and 403 for keys that cannot write", async () => {
    verifyApiKey.mockResolvedValue(null);
    expect((await get("sk_cd_bad")).status).toBe(401);
    verifyApiKey.mockResolvedValue({ keyId: 1, organizationId: 2, scope: "mcp_read" });
    expect((await get("sk_cd_read")).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("tells the client which contract to speak and what it is connected to", async () => {
    const response = await get("sk_cd_write");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.contractVersion).toBe("2.0.0");
    expect(json.supportedContractVersions).toEqual(["2.0.0"]);
    expect(json.minSupportedContractVersion).toBe("2.0.0");
    expect(json.organization).toEqual({ name: "Acme" });
  });

  it("lists only the key's organization's products with their executor, ledger head and repository binding", async () => {
    const json = await (await get("sk_cd_write")).json();
    expect(json.products).toEqual([
      {
        slug: "acme-api",
        name: "Acme API",
        analysisExecutor: "client",
        currentVersionId: 32,
        currentRevisionSha: SHA_B,
        sourceRoots: [{ path: "apps/api", role: "api" }],
        repository: { repositoryId: 57, provider: "github", host: "github.com", owner: "acme", name: "api" },
      },
      {
        slug: "local-notes",
        name: "Local Notes",
        analysisExecutor: "client",
        currentVersionId: 31,
        currentRevisionSha: SHA_A,
        sourceRoots: [],
        // 纯本地仓库的属主是服务端为唯一键拼出来的，不外传。
        repository: { repositoryId: 58, provider: "local", host: null, owner: null, name: null },
      },
      { slug: "hosted", name: "Hosted", analysisExecutor: "server", currentVersionId: null, currentRevisionSha: null, sourceRoots: [], repository: null },
    ]);
    expect(execute).toHaveBeenCalledWith("SELECT name FROM organizations WHERE id = ? LIMIT 1", [2]);
    const productsSql = String(execute.mock.calls.find(([sql]) => sql.includes("FROM products p LEFT JOIN repositories"))?.[0]);
    expect(productsSql).toContain("p.source_roots AS sourceRoots");
    expect(execute.mock.calls.find(([sql]) => sql.includes("FROM products p LEFT JOIN repositories"))?.[1]).toEqual([2]);
  });

  it("asks nothing about versions when no product has a ledger yet", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT name FROM organizations")) return [[{ name: "Acme" }], []];
      if (sql.includes("FROM products p LEFT JOIN repositories")) return [[{ ...rows[2], slug: "fresh", repositoryId: 60, provider: "gitlab", host: "gitlab.corp.com", owner: "team", repositoryName: "api" }], []];
      throw new Error(`unrouted sql: ${sql}`);
    });
    const json = await (await get("sk_cd_write")).json();
    expect(json.products).toEqual([{ slug: "fresh", name: "Hosted", analysisExecutor: "server", currentVersionId: null, currentRevisionSha: null, sourceRoots: [], repository: { repositoryId: 60, provider: "gitlab", host: "gitlab.corp.com", owner: "team", name: "api" } }]);
  });
});
