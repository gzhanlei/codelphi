import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { verifyApiKey, consumeRateLimit, publishProposal, loadPublishTarget, recordProposalRejection, execute } = vi.hoisted(() => ({
  verifyApiKey: vi.fn(),
  consumeRateLimit: vi.fn(),
  publishProposal: vi.fn(),
  loadPublishTarget: vi.fn(),
  recordProposalRejection: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));
vi.mock("@/lib/mcp/api-keys", () => ({ verifyApiKey }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit }));
vi.mock("@/lib/client-proposal/publish", () => ({ publishProposal, loadPublishTarget, recordProposalRejection, ProposalRejection: class extends Error { code: string; details: unknown; status: number; constructor(code: string, message: string, details: unknown = null, status = 409) { super(message); this.code = code; this.details = details; this.status = status; this.name = "ProposalRejection"; } } }));

const { POST } = await import("../app/api/products/[slug]/analysis-proposals/route");
const { sealProposal } = await import("../lib/client-proposal/contract");
const { ProposalRejection } = await import("../lib/client-proposal/publish");

const writer = { keyId: 7, organizationId: 2, scope: "snapshot_write" };
const target = { productId: 9, organizationId: 2, productSlug: "acme", productName: "Acme" };
const receipt = { replayed: false, repositoryId: 57, specVersionId: 400, releaseId: 300, revisionSha: "a".repeat(40), verification: { reanalyzed: 3, deterministicallyCarried: 0, clientDeclaredUnaffected: 0 } };

function body(): Record<string, unknown> {
  return {
    contractVersion: "2.0.0",
    artifactKind: "codelphi-analysis-proposal",
    idempotencyKey: "6f1c0d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
    mode: "full",
    language: "zh-CN",
    repository: { repositoryId: 57, provider: "github", host: "github.com", owner: "acme", name: "api" },
    revision: { sha: "a".repeat(40), treeSha: null, committedAt: "2026-11-26T10:00:00.000Z", title: "feat", branch: "main" },
    base: null,
    window: null,
    proposal: {
      product: { description: "Acme API 的行为账本。", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
      release: { title: "登录", summary: "登录" },
      changes: [],
      features: [{ name: "登录", summary: "登录", scenarios: [{ reference: "HP-1", context: "访客", action: "登录", outcome: "进入首页", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 10 }] }] }],
    },
    carryClaims: [],
    coverage: null,
    flows: [],
    presentation: {},
    client: { version: "1.0.0", pipelineVersion: "p1", promptVersion: "p", model: "tenant-model", impactRulesVersion: "impact-v1", analyzedAt: "2026-11-26T10:30:00.000Z" },
  };
}

function request(payload: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/products/acme/analysis-proposals", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk_cd_write", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

const post = (req: NextRequest) => POST(req, { params: Promise.resolve({ slug: "acme" }) });

beforeEach(() => {
  vi.clearAllMocks();
  verifyApiKey.mockResolvedValue(writer);
  consumeRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  loadPublishTarget.mockResolvedValue(target);
  publishProposal.mockResolvedValue(receipt);
  recordProposalRejection.mockResolvedValue(undefined);
});

describe("POST /api/products/[slug]/analysis-proposals", () => {
  it("returns 401 without a valid key and 403 for keys that cannot write", async () => {
    verifyApiKey.mockResolvedValue(null);
    expect((await post(request(body()))).status).toBe(401);
    verifyApiKey.mockResolvedValue({ keyId: 1, organizationId: 2, scope: "mcp_read" });
    expect((await post(request(body()))).status).toBe(403);
    expect(publishProposal).not.toHaveBeenCalled();
  });

  it("publishes a sealed proposal for the key's organization and returns the receipt", async () => {
    const response = await post(request(sealProposal(body())));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
    expect(loadPublishTarget).toHaveBeenCalledWith(expect.anything(), "acme", 2);
    expect(publishProposal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ proposalHash: expect.stringMatching(/^sha256:/) }), target);
    expect(recordProposalRejection).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON or not a proposal, and records the rejection without its content", async () => {
    expect((await post(request("{not json"))).status).toBe(400);
    const response = await post(request({ hello: "world" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_proposal");
    expect(recordProposalRejection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "invalid_proposal", organizationId: 2, productId: 9 }));
  });

  it("answers 400 when the content does not match the reported hash", async () => {
    const sealed = sealProposal(body());
    const response = await post(request({ ...sealed, proposal: { ...sealed.proposal, features: [] } }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("proposal_hash_mismatch");
    expect(publishProposal).not.toHaveBeenCalled();
  });

  it("maps a contract version it does not speak to 409 and says which version it needs", async () => {
    const response = await post(request({ ...sealProposal(body()), contractVersion: "0.9.0" }));
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toBe("contract_version_mismatch");
    expect(json.minSupportedContractVersion).toBe("2.0.0");
  });

  it("refuses a proposal that carries source text, naming the rules and fields but never the text", async () => {
    const leaked = "const apiKey = 'sk_live_abcdef';\nconnect(apiKey);\nuploadEverything();";
    const response = await post(request(sealProposal({ ...body(), presentation: { note: leaked } })));
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.error).toBe("artifact_contains_source");
    expect(json.hits).toEqual([{ rule: "code_run", path: "presentation.note", line: 1 }]);
    expect(JSON.stringify(json)).not.toContain("sk_live_abcdef");
    expect(publishProposal).not.toHaveBeenCalled();
    expect(JSON.stringify(recordProposalRejection.mock.calls)).not.toContain("sk_live_abcdef");
  });

  it("maps the publish service's rejections to their status and details", async () => {
    const details = { current: { specVersionId: 401, revisionSha: "b".repeat(40) }, changedFeatureKeys: ["login"], verdict: "reanalyze" };
    loadPublishTarget.mockRejectedValue(new ProposalRejection("base_changed", "moved on", details));
    const response = await post(request(sealProposal(body())));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "base_changed", message: "moved on", details });
    expect(recordProposalRejection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "base_changed", productId: null, repositoryId: 57 }));
  });

  it("returns 404 when the product is not this organization's, and 409 when the product is analysed on the server", async () => {
    loadPublishTarget.mockRejectedValueOnce(new ProposalRejection("product_not_found", "no such product", null, 404));
    expect((await post(request(sealProposal(body())))).status).toBe(404);
    loadPublishTarget.mockRejectedValueOnce(new ProposalRejection("analysis_mode_is_server", "server-analysed", null, 409));
    expect((await post(request(sealProposal(body())))).status).toBe(409);
  });

  it("keeps an unexpected failure out of the client's view and off the audit", async () => {
    publishProposal.mockRejectedValue(new Error("boom with internal details"));
    const response = await post(request(sealProposal(body())));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "proposal_publish_failed" });
    expect(recordProposalRejection).not.toHaveBeenCalled();
  });

  it("accepts chunked uploads: acknowledges parts and assembles the last one", async () => {
    const sealed = JSON.stringify(sealProposal(body()));
    // 和 BYO 快照导入同一个协议：分片确认是 200 加 { received: true }，限流只在收齐时计一次。
    const first = await post(request(sealed.slice(0, 100), { "x-import-id": "upload-1", "x-import-chunk-index": "0", "x-import-chunk-total": "2" }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(publishProposal).not.toHaveBeenCalled();
    expect(consumeRateLimit).not.toHaveBeenCalled();
    const last = await post(request(sealed.slice(100), { "x-import-id": "upload-1", "x-import-chunk-index": "1", "x-import-chunk-total": "2" }));
    expect(last.status).toBe(200);
    expect(await last.json()).toEqual(receipt);
    expect(consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(consumeRateLimit).toHaveBeenCalledWith(expect.objectContaining({ identity: "analysis-proposals:7", limit: 10, windowSeconds: 3600 }));
    consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 3600 });
    const limited = await post(request(sealed));
    expect(limited.status).toBe(429);
  });

  it("rejects malformed chunk headers", async () => {
    const response = await post(request("{}", { "x-import-id": "upload-2", "x-import-chunk-index": "5", "x-import-chunk-total": "2" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_chunk" });
  });
});
