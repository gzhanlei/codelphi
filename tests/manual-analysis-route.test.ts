import { after, NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/products/[slug]/analyze/route";
import { POST as reanalyzeLatest } from "../app/api/products/[slug]/reanalyze-latest/route";
import { queueAnalysis, runAnalysis } from "@/lib/analysis";
import { ClientAnalysisError, MODEL_NOT_CONFIGURED_RESPONSE_MESSAGE, ModelNotConfiguredError } from "@/lib/analysis-executor";
import { resolveManualAnalysis } from "@/lib/manual-analysis";

vi.mock("next/server", async (importOriginal) => ({ ...await importOriginal<typeof import("next/server")>(), after: vi.fn() }));
vi.mock("@/lib/analysis", () => ({ queueAnalysis: vi.fn(), runAnalysis: vi.fn() }));
vi.mock("@/lib/manual-analysis", () => ({ resolveManualAnalysis: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ execute: async () => [[{ sha: "sha-release" }]] }) }));
vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("@/lib/product-access", () => ({
  requireProductAccess: vi.fn(async () => ({
    product: { id: 2, slug: "radar", name: "Radar", description: "", organizationId: 7 },
    organization: { id: 7, slug: "team", name: "Team", role: "owner" },
    role: "owner",
    via: "organization",
  })),
}));

function request(slug: string) {
  return POST(new NextRequest(`http://localhost/api/products/${slug}/analyze`, { method: "POST" }), { params: Promise.resolve({ slug }) });
}

describe("manual analysis route", () => {
  beforeEach(() => {
    vi.mocked(resolveManualAnalysis).mockReset();
    vi.mocked(queueAnalysis).mockReset();
    vi.mocked(runAnalysis).mockReset();
    vi.mocked(after).mockReset();
  });

  it("returns 404 when the repository is absent", async () => {
    vi.mocked(resolveManualAnalysis).mockResolvedValue(null);
    const response = await request("missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "product_not_found" });
    expect(queueAnalysis).not.toHaveBeenCalled();
  });

  it("queues and schedules analysis with the resolved repository and HEAD", async () => {
    vi.mocked(resolveManualAnalysis).mockResolvedValue({ repositoryId: 9, afterSha: "sha-head" });
    vi.mocked(queueAnalysis).mockResolvedValue(33);
    const response = await request("radar");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, runId: 33 });
    expect(resolveManualAnalysis).toHaveBeenCalledWith("radar", 7);
    expect(queueAnalysis).toHaveBeenCalledWith(9, null, "sha-head", "manual");
    const scheduled = vi.mocked(after).mock.calls[0][0];
    expect(typeof scheduled).toBe("function");
    if (typeof scheduled === "function") await scheduled();
    expect(runAnalysis).toHaveBeenCalledWith(33);
  });

  it("answers 409 and schedules nothing when the product is analysed by the client", async () => {
    vi.mocked(resolveManualAnalysis).mockResolvedValue({ repositoryId: 9, afterSha: "sha-head" });
    vi.mocked(queueAnalysis).mockRejectedValue(new ClientAnalysisError());
    const response = await request("radar");
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("analysis_mode_is_client");
    expect(typeof body.message).toBe("string");
    expect(after).not.toHaveBeenCalled();
  });

  it("answers 409 with a pointer to the settings and schedules nothing when the workspace has no model of its own", async () => {
    vi.mocked(resolveManualAnalysis).mockResolvedValue({ repositoryId: 9, afterSha: "sha-head" });
    vi.mocked(queueAnalysis).mockRejectedValue(new ModelNotConfiguredError());
    const response = await request("radar");
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ error: "model_not_configured", message: MODEL_NOT_CONFIGURED_RESPONSE_MESSAGE });
    expect(body.message).toContain("模型配置");
    expect(after).not.toHaveBeenCalled();
  });
});

describe("reanalyze-latest route", () => {
  beforeEach(() => {
    vi.mocked(resolveManualAnalysis).mockReset();
    vi.mocked(queueAnalysis).mockReset();
    vi.mocked(runAnalysis).mockReset();
    vi.mocked(after).mockReset();
  });

  it("answers 409 and schedules nothing when the product is analysed by the client", async () => {
    vi.mocked(resolveManualAnalysis).mockResolvedValue({ repositoryId: 9, afterSha: "sha-head" });
    vi.mocked(queueAnalysis).mockRejectedValue(new ClientAnalysisError());
    const response = await reanalyzeLatest(
      new NextRequest("http://localhost/api/products/radar/reanalyze-latest", { method: "POST", body: JSON.stringify({ confirm: true }), headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ slug: "radar" }) },
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("analysis_mode_is_client");
    expect(typeof body.message).toBe("string");
    expect(after).not.toHaveBeenCalled();
  });

  it("answers 409 and schedules nothing when the workspace has no model of its own", async () => {
    vi.mocked(resolveManualAnalysis).mockResolvedValue({ repositoryId: 9, afterSha: "sha-head" });
    vi.mocked(queueAnalysis).mockRejectedValue(new ModelNotConfiguredError());
    const response = await reanalyzeLatest(
      new NextRequest("http://localhost/api/products/radar/reanalyze-latest", { method: "POST", body: JSON.stringify({ confirm: true }), headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ slug: "radar" }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "model_not_configured", message: MODEL_NOT_CONFIGURED_RESPONSE_MESSAGE });
    expect(after).not.toHaveBeenCalled();
  });

  it("still queues the latest released SHA for a server-analysed product", async () => {
    vi.mocked(resolveManualAnalysis).mockResolvedValue({ repositoryId: 9, afterSha: "sha-head" });
    vi.mocked(queueAnalysis).mockResolvedValue(34);
    const response = await reanalyzeLatest(
      new NextRequest("http://localhost/api/products/radar/reanalyze-latest", { method: "POST", body: JSON.stringify({ confirm: true }), headers: { "content-type": "application/json" } }),
      { params: Promise.resolve({ slug: "radar" }) },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, runId: 34, sha: "sha-release" });
    expect(queueAnalysis).toHaveBeenCalledWith(9, null, "sha-release", "manual");
  });
});
