import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, searchSpec, renderExplainer, resolveDemo } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  searchSpec: vi.fn(),
  renderExplainer: vi.fn(),
  resolveDemo: vi.fn(),
}));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/spec-search", () => ({ searchSpec }));
vi.mock("../lib/regression-tasks", () => ({
  loadRegressionTasks: vi.fn(async () => []),
  renderRegressionTaskMarkdown: vi.fn(() => "# regression markdown"),
}));
vi.mock("../lib/product-explainer", () => ({ renderProductExplainerHtml: renderExplainer }));
vi.mock("../lib/product-details", () => ({ getProductDetails: vi.fn(async () => ({ product: { slug: "codelphi", name: "CoDelphi" } })) }));
vi.mock("../lib/product-overview", () => ({ buildProductOverview: vi.fn(() => ({ title: "CoDelphi" })) }));
vi.mock("../lib/artifact-response", () => ({ artifactSandboxHeaders: () => ({}) }));

vi.mock("../lib/session", () => ({
  getSessionUser: vi.fn(),
  requireSessionUser: vi.fn(),
}));
vi.mock("../lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("../lib/public-demo", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/public-demo")>(),
  resolvePublicDemoProduct: resolveDemo,
}));

import { GET as searchGET } from "../app/api/products/[slug]/spec/search/route";
import { GET as regressionGET } from "../app/api/products/[slug]/releases/[id]/regression/route";
import { GET as explainerGET } from "../app/api/products/[slug]/explainer/route";
import { getSessionUser, requireSessionUser } from "../lib/session";
import { requireProductAccess } from "../lib/product-access";
// 模块 mock 顶替了公开导出；助手本身的单测要走真实实现（它只依赖已 mock 的 lib/db）。
const { resolvePublicDemoProduct } = await vi.importActual<typeof import("../lib/public-demo")>("../lib/public-demo");

const access = {
  product: { id: 1, slug: "codelphi", name: "CoDelphi", description: "d", organizationId: 7 },
  organization: { id: 7, slug: "team", name: "Team", role: "viewer" },
  role: "viewer",
  via: "organization",
} as const;

const demoProduct = { id: 1, slug: "codelphi", name: "CoDelphi", organizationId: 7 };

function searchRequest(query = "") {
  return new NextRequest(`https://codelphi.example/api/products/codelphi/spec/search${query}`);
}

function regressionRequest(id = "12") {
  return new NextRequest(`https://codelphi.example/api/products/codelphi/releases/${id}/regression`);
}

function explainerRequest() {
  return new NextRequest("https://codelphi.example/api/products/codelphi/explainer");
}

function params(slug = "codelphi", id = "12") {
  return { params: Promise.resolve({ slug, id }) };
}

describe("anonymous read-only access for the public demo product", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(requireSessionUser).mockRejectedValue(new Error("should not require a session"));
    vi.mocked(requireProductAccess).mockResolvedValue(null);
    resolveDemo.mockResolvedValue(demoProduct);
  });

  it("serves spec search to anonymous visitors on the public demo product", async () => {
    searchSpec.mockResolvedValue({ features: [{ id: 9, name: "发布通知渠道", summary: "s" }], scenarios: [] });
    const response = await searchGET(searchRequest("?q=通知"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(200);
    const payload = await response.json() as { features: Array<{ name: string }> };
    expect(payload.features).toHaveLength(1);
    expect(searchSpec).toHaveBeenCalledWith(1, "通知");
  });

  it("still serves spec search to logged-in members through their workspace", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "user", email: "pm@example.com" } as never);
    vi.mocked(requireProductAccess).mockResolvedValue(access as never);
    searchSpec.mockResolvedValue({ features: [], scenarios: [] });
    const response = await searchGET(searchRequest("?q=x"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(200);
    expect(searchSpec).toHaveBeenCalledWith(1, "x");
    expect(resolveDemo).not.toHaveBeenCalled();
  });

  it("keeps spec search closed for anonymous visitors on non-demo products", async () => {
    resolveDemo.mockResolvedValue(null);
    const response = await searchGET(searchRequest("?q=x"), { params: Promise.resolve({ slug: "chandler" }) });
    expect(response.status).toBe(401);
  });

  it("returns 404 for logged-in users without access instead of leaking the demo fallback", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "user", email: "pm@example.com" } as never);
    resolveDemo.mockResolvedValue(null);
    const response = await searchGET(searchRequest("?q=x"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(404);
  });

  it("serves the regression markdown export to anonymous visitors on the public demo product", async () => {
    dbExecute.mockResolvedValue([[{ id: 12, title: "t", summary: "s", sha: "abc", url: "u", committedAt: new Date(), specVersionId: 5 }], undefined]);
    const response = await regressionGET(regressionRequest(), params());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("# regression markdown");
  });

  it("keeps the regression export closed for anonymous visitors on non-demo products", async () => {
    resolveDemo.mockResolvedValue(null);
    const response = await regressionGET(regressionRequest(), params("chandler"));
    expect(response.status).toBe(401);
  });

  it("returns 404 when the release does not belong to the demo product", async () => {
    dbExecute.mockResolvedValue([[], undefined]);
    const response = await regressionGET(regressionRequest(), params());
    expect(response.status).toBe(404);
  });

  it("serves the explainer export to anonymous visitors on the public demo product", async () => {
    renderExplainer.mockReturnValue("<html>explainer</html>");
    const response = await explainerGET(explainerRequest(), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("explainer");
  });

  it("keeps the explainer export closed for anonymous visitors on non-demo products", async () => {
    resolveDemo.mockResolvedValue(null);
    const response = await explainerGET(explainerRequest(), { params: Promise.resolve({ slug: "chandler" }) });
    expect(response.status).toBe(401);
  });
});

describe("resolvePublicDemoProduct", () => {
  it("resolves a product flagged as public demo in the database", async () => {
    dbExecute.mockResolvedValue([[{ id: 1, slug: "codelphi", name: "CoDelphi", organization_id: 7, is_public_demo: 1 }], undefined]);
    expect(await resolvePublicDemoProduct("codelphi")).toEqual(demoProduct);
  });

  it("falls back to the env whitelist for products not flagged in the database", async () => {
    process.env.PUBLIC_DEMO_SLUGS = "codelphi";
    try {
      dbExecute.mockResolvedValue([[{ id: 2, slug: "codelphi", name: "CoDelphi", organization_id: 7, is_public_demo: 0 }], undefined]);
      expect(await resolvePublicDemoProduct("codelphi")).toEqual({ id: 2, slug: "codelphi", name: "CoDelphi", organizationId: 7 });
    } finally {
      delete process.env.PUBLIC_DEMO_SLUGS;
    }
  });

  it("returns null for products outside both gates", async () => {
    dbExecute.mockResolvedValue([[{ id: 3, slug: "chandler", name: "Chandler", organization_id: 7, is_public_demo: 0 }], undefined]);
    expect(await resolvePublicDemoProduct("chandler")).toBeNull();
  });

  it("returns null when the product does not exist", async () => {
    dbExecute.mockResolvedValue([[], undefined]);
    expect(await resolvePublicDemoProduct("ghost")).toBeNull();
  });
});
