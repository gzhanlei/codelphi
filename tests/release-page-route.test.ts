import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/products/[slug]/releases/route";
import { loadReleasePage } from "../lib/product-details";

const { loadPage } = vi.hoisted(() => ({ loadPage: vi.fn() }));

vi.mock("../lib/session", () => ({
  getSessionUser: vi.fn(async () => ({ sub: "user", email: "pm@example.com" })),
  requireSessionUser: vi.fn(async () => ({ sub: "user", email: "pm@example.com" })),
}));
vi.mock("../lib/product-access", () => ({
  requireProductAccess: vi.fn(async () => ({
    product: { id: 1, slug: "codelphi", name: "CoDelphi", description: "d", organizationId: 7 },
    organization: { id: 7, slug: "team", name: "Team", role: "viewer" },
    role: "viewer",
    via: "organization",
  })),
}));
vi.mock("../lib/product-details", () => ({ loadReleasePage: loadPage, publicDemoSlugs: vi.fn(() => new Set(["codelphi"])) }));
vi.mock("../lib/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/env")>(),
  publicDemoSlugs: () => new Set(["codelphi"]),
}));

function request(query = "") {
  return new NextRequest(`https://codelphi.example/api/products/codelphi/releases${query}`);
}

describe("release pagination route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPage.mockResolvedValue({ total: 29, releases: [{ id: 3 }], changes: [{ id: 9 }], behaviorChanges: [{ id: 5 }] });
  });

  it("returns the requested page with the total count", async () => {
    const response = await GET(request("?offset=10&limit=10"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(200);
    const payload = await response.json() as { total: number; releases: unknown[] };
    expect(payload.total).toBe(29);
    expect(payload.releases).toHaveLength(1);
    expect(loadPage).toHaveBeenCalledWith("codelphi", 7, 10, 10);
  });

  it("rejects invalid offsets and oversized limits", async () => {
    const bad = await GET(request("?offset=-1"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(bad.status).toBe(400);
    const big = await GET(request("?limit=500"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(big.status).toBe(400);
  });

  it("returns 404 when the product is unknown", async () => {
    loadPage.mockResolvedValue(null);
    const response = await GET(request(), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(404);
  });
});
