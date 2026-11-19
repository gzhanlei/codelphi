import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { verifyApiKey, consumeRateLimit, importSnapshotArtifact } = vi.hoisted(() => ({
  verifyApiKey: vi.fn(),
  consumeRateLimit: vi.fn(),
  importSnapshotArtifact: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: vi.fn(),
    getConnection: async () => ({
      execute: vi.fn(),
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    }),
  }),
}));
vi.mock("@/lib/mcp/api-keys", () => ({ verifyApiKey }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit }));
vi.mock("@/lib/snapshot-import", () => ({ ImportValidationError: class extends Error { code: string; details: unknown; constructor(code: string, message: string, details?: unknown) { super(message); this.code = code; this.details = details ?? null; } }, importSnapshotArtifact }));
const { ImportValidationError: MockImportError } = await import("../lib/snapshot-import");
vi.mock("@/lib/extraction-contract", () => ({ CONTRACT_VERSION: "1.0.0" }));

const { POST } = await import("../app/api/products/import-snapshot/route");

const request = (key?: string) => new NextRequest("http://localhost/api/products/import-snapshot", {
  method: "POST",
  headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify({ artifactKind: "codelphi-radar-snapshot" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  consumeRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

describe("POST /api/products/import-snapshot", () => {
  it("returns 401 without a valid key (防枚举：与 MCP 面同一语义)", async () => {
    verifyApiKey.mockResolvedValue(null);
    const response = await POST(request("sk_cd_bad"));
    expect(response.status).toBe(401);
    expect(importSnapshotArtifact).not.toHaveBeenCalled();
  });

  it("returns 403 for mcp_read keys (snapshot_write only)", async () => {
    verifyApiKey.mockResolvedValue({ keyId: 1, organizationId: 2, scope: "mcp_read" });
    const response = await POST(request("sk_cd_read"));
    expect(response.status).toBe(403);
    expect(importSnapshotArtifact).not.toHaveBeenCalled();
  });

  it("imports for snapshot_write keys and returns the receipt", async () => {
    verifyApiKey.mockResolvedValue({ keyId: 7, organizationId: 2, scope: "snapshot_write" });
    importSnapshotArtifact.mockResolvedValue({ productId: 9, slug: "sample-repo", featuresImported: 3, scenariosImported: 21, mode: "create_product", binding: "created" });
    const response = await POST(request("sk_cd_write"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ imported: true, productId: 9, scenariosImported: 21 });
    expect(importSnapshotArtifact).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 2, currentContractVersion: "1.0.0" }), expect.objectContaining({ artifactKind: "codelphi-radar-snapshot" }));
  });

  it("maps ImportValidationError codes to 400/409 without leaking internals", async () => {
    verifyApiKey.mockResolvedValue({ keyId: 7, organizationId: 2, scope: "snapshot_write" });
    importSnapshotArtifact.mockRejectedValue(new MockImportError("product_has_content", "x", null));
    expect((await POST(request("sk_cd_write"))).status).toBe(409);
    importSnapshotArtifact.mockRejectedValue(new MockImportError("invalid_artifact", "x", []));
    expect((await POST(request("sk_cd_write"))).status).toBe(400);
  });
});

describe("POST /api/products/import-snapshot 分片组装", () => {
  const artifact = { artifactKind: "codelphi-radar-snapshot", exportVersion: 1, contractVersion: "1.0.0", identity: { name: "x", revision: "a".repeat(40), workingTreeDirty: false }, language: "en", features: [{ name: "F", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [] }] }] };
  const whole = Buffer.from(JSON.stringify(artifact), "utf8");

  it("assembles two chunks into one artifact and imports once on the final chunk", async () => {
    verifyApiKey.mockResolvedValue({ keyId: 7, organizationId: 2, scope: "snapshot_write" });
    importSnapshotArtifact.mockClear();
    importSnapshotArtifact.mockResolvedValue({ productId: 9, slug: "x", featuresImported: 1, scenariosImported: 1, mode: "create_product", binding: "created" });
    const chunkA = whole.subarray(0, 10);
    const chunkB = whole.subarray(10);
    const base = { "content-type": "application/octet-stream", authorization: "Bearer sk_cd_write" };

    const first = await POST(new NextRequest("http://localhost/api/products/import-snapshot", {
      method: "POST",
      headers: { ...base, "x-import-id": "u1", "x-import-chunk-index": "0", "x-import-chunk-total": "2" },
      body: new Uint8Array(chunkA),
    }));
    expect(first.status).toBe(200);
    expect((await first.json()).received).toBe(true);
    expect(importSnapshotArtifact).not.toHaveBeenCalled(); // 末块才组装导入

    const last = await POST(new NextRequest("http://localhost/api/products/import-snapshot", {
      method: "POST",
      headers: { ...base, "x-import-id": "u1", "x-import-chunk-index": "1", "x-import-chunk-total": "2" },
      body: new Uint8Array(chunkB),
    }));
    expect(last.status).toBe(200);
    expect(importSnapshotArtifact).toHaveBeenCalledTimes(1);
    expect(importSnapshotArtifact.mock.calls[0][1]).toEqual(artifact); // 组装结果与原始 artifact 逐字节等价
  });

  it("rejects malformed chunk headers", async () => {
    verifyApiKey.mockResolvedValue({ keyId: 7, organizationId: 2, scope: "snapshot_write" });
    const response = await POST(new NextRequest("http://localhost/api/products/import-snapshot", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", authorization: "Bearer sk_cd_write", "x-import-id": "u2", "x-import-chunk-index": "5", "x-import-chunk-total": "2" },
      body: new Uint8Array([1]),
    }));
    expect(response.status).toBe(400);
  });
});
