import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/products/[slug]/explainer/route";
import { getProductDetails } from "../lib/product-details";
import { buildProductOverview } from "../lib/product-overview";
import { renderProductExplainerHtml } from "../lib/product-explainer";

vi.mock("../lib/session", () => ({ getSessionUser: vi.fn(async () => ({ sub: "user" })), requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("../lib/product-access", () => ({
  requireProductAccess: vi.fn(async () => ({
    product: { id: 1, slug: "radar", name: "Radar", description: "", organizationId: 7 },
    organization: { id: 7, slug: "team", name: "Team", role: "owner" },
    role: "owner",
    via: "organization",
  })),
}));
vi.mock("../lib/product-details", () => ({ getProductDetails: vi.fn() }));
vi.mock("../lib/product-overview", () => ({ buildProductOverview: vi.fn() }));
vi.mock("../lib/product-explainer", () => ({ renderProductExplainerHtml: vi.fn() }));
vi.mock("../lib/artifact-response", () => ({ artifactSandboxHeaders: vi.fn(() => ({ "Content-Security-Policy": "sandbox" })) }));

const request = new NextRequest("https://codelphi.com/api/products/radar/explainer");
const context = { params: Promise.resolve({ slug: "radar" }) };

describe("product Explainer route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProductDetails).mockResolvedValue({ product: { id: 1, slug: "radar" } } as never);
    vi.mocked(buildProductOverview).mockReturnValue({ headline: "Radar" } as never);
    vi.mocked(renderProductExplainerHtml).mockReturnValue("<html>explainer</html>");
  });

  it("returns 404 for an unknown product", async () => {
    vi.mocked(getProductDetails).mockResolvedValue(null);
    const response = await GET(request, context);
    expect(response.status).toBe(404);
    expect(renderProductExplainerHtml).not.toHaveBeenCalled();
  });

  it("renders the explainer from the product overview without external engines", async () => {
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>explainer</html>");
    expect(renderProductExplainerHtml).toHaveBeenCalledWith({ headline: "Radar" });
  });

  it("returns a safe render error", async () => {
    vi.mocked(renderProductExplainerHtml).mockImplementation(() => { throw new Error("render failed"); });
    const response = await GET(request, context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "render failed" });
  });
});
