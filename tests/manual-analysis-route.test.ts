import { after, NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/products/[slug]/analyze/route";
import { queueAnalysis, runAnalysis } from "@/lib/analysis";
import { resolveManualAnalysis } from "@/lib/manual-analysis";

vi.mock("next/server", async (importOriginal) => ({ ...await importOriginal<typeof import("next/server")>(), after: vi.fn() }));
vi.mock("@/lib/analysis", () => ({ queueAnalysis: vi.fn(), runAnalysis: vi.fn() }));
vi.mock("@/lib/manual-analysis", () => ({ resolveManualAnalysis: vi.fn() }));
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
});
