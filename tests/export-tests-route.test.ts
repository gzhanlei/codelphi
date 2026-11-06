import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/products/[slug]/export/tests/route";
import { getProductDetails } from "../lib/product-details";

vi.mock("../lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("../lib/product-access", () => ({
  requireProductAccess: vi.fn(async () => ({
    product: { id: 1, slug: "radar", name: "Radar", description: "", organizationId: 7 },
    organization: { id: 7, slug: "team", name: "Team", role: "owner" },
    role: "owner",
    via: "organization",
  })),
}));
vi.mock("../lib/product-details", () => ({ getProductDetails: vi.fn() }));

const details = {
  features: [{ id: 1, name: "登录", summary: "OAuth", parentId: null, source: "generated" }],
  scenarios: [{ id: 1, featureId: 1, reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", source: "generated", evidence: [] }],
};
const context = { params: Promise.resolve({ slug: "radar" }) };

describe("test skeleton export route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProductDetails).mockResolvedValue(details as never);
  });

  it("downloads a gherkin skeleton by default", async () => {
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/export/tests"), context);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Feature: 登录");
    expect(response.headers.get("content-disposition")).toContain("radar-tests.feature");
  });

  it("supports the markdown format and rejects unknown ones", async () => {
    const markdown = await GET(new NextRequest("https://radar.example/api/products/radar/export/tests?format=markdown"), context);
    expect(await markdown.text()).toContain("- [ ] HP-1");
    expect(markdown.headers.get("content-disposition")).toContain("radar-tests.md");

    const invalid = await GET(new NextRequest("https://radar.example/api/products/radar/export/tests?format=pdf"), context);
    expect(invalid.status).toBe(400);
  });

  it("returns 404 for an unknown product", async () => {
    vi.mocked(getProductDetails).mockResolvedValue(null);
    const response = await GET(new NextRequest("https://radar.example/api/products/radar/export/tests"), context);
    expect(response.status).toBe(404);
  });
});
