import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/products/[slug]/spec.json/route";
import { getProductDetails } from "../lib/product-details";

const { getSessionUser, resolveDemo } = vi.hoisted(() => ({ getSessionUser: vi.fn(), resolveDemo: vi.fn() }));

vi.mock("../lib/session", () => ({ getSessionUser }));
vi.mock("../lib/public-demo", () => ({ resolveLegacyPublicDemoProduct: resolveDemo }));
vi.mock("../lib/product-access", () => ({
  requireProductAccess: vi.fn(async () => ({
    product: { id: 1, slug: "radar", name: "Radar", description: "d", organizationId: 7 },
    organization: { id: 7, slug: "team", name: "Team", role: "viewer" },
    role: "viewer",
    via: "organization",
  })),
}));
vi.mock("../lib/product-details", () => ({ getProductDetails: vi.fn() }));

const details = {
  product: { id: 1, slug: "radar", name: "Radar", description: "代码驱动的产品知识", descriptionSource: "generated" },
  features: [{ id: 1, name: "统一登录", summary: "OAuth", parentId: null, source: "generated", staleSince: null, staleChangeId: null }],
  scenarios: [{ id: 1, featureId: 1, reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: [{ path: "lib/auth.ts", startLine: 5 }] }],
};
const context = { params: Promise.resolve({ slug: "radar" }) };

describe("spec.json export route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProductDetails).mockResolvedValue(details as never);
    getSessionUser.mockResolvedValue({ sub: "user", email: "pm@example.com" });
    resolveDemo.mockResolvedValue(null);
  });

  it("serves the current snapshot with stable paths and evidence for machine readers", async () => {
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/spec.json"), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as { product: { slug: string }; features: Array<{ name: string; stablePath: string; scenarios: Array<{ reference: string; evidence: unknown }> }>; scenarioCount: number };
    expect(payload.product.slug).toBe("radar");
    expect(payload.features[0].stablePath).toBe("/products/team/radar/spec/feature/%E7%BB%9F%E4%B8%80%E7%99%BB%E5%BD%95");
    expect(payload.features[0].scenarios[0].evidence).toEqual([{ path: "lib/auth.ts", startLine: 5 }]);
    expect(payload.scenarioCount).toBe(1);
  });

  it("returns 404 for an unknown product", async () => {
    vi.mocked(getProductDetails).mockResolvedValue(null);
    const response = await GET(new NextRequest("https://radar.example/api/products/missing/spec.json"), context);
    expect(response.status).toBe(404);
  });

  it("returns 401 JSON instead of a login redirect so curl callers fail cleanly", async () => {
    getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/spec.json"), context);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "未登录" });
  });

  it("serves the public demo product to anonymous visitors without a session", async () => {
    getSessionUser.mockResolvedValue(null);
    resolveDemo.mockResolvedValue({ id: 9, slug: "radar", name: "Radar", organizationId: 7, organizationSlug: "team" });
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/spec.json"), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as { scenarioCount: number };
    expect(payload.scenarioCount).toBe(1);
    expect(getProductDetails).toHaveBeenCalledWith("radar", 7);
  });

  it("returns 404 for logged-in users without access instead of leaking the demo fallback", async () => {
    resolveDemo.mockResolvedValue(null);
    const { requireProductAccess } = await import("../lib/product-access");
    vi.mocked(requireProductAccess).mockResolvedValueOnce(null as never);
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/spec.json"), context);
    expect(response.status).toBe(404);
  });
});
