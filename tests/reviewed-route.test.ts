import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/products/[slug]/releases/[id]/reviewed/route";

const { execute, getSessionUser, publicDemoSlugs } = vi.hoisted(() => ({
  execute: vi.fn(),
  getSessionUser: vi.fn(),
  publicDemoSlugs: vi.fn(),
}));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute }) }));
vi.mock("../lib/session", () => ({ getSessionUser }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: vi.fn(async () => null) }));
vi.mock("../lib/env", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/env")>(), publicDemoSlugs }));

function request(id = "7", slug = "codelphi") {
  return new NextRequest(`https://codelphi.example/api/products/${slug}/releases/${id}/reviewed`);
}

describe("release reviewed items route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionUser.mockResolvedValue(null);
    publicDemoSlugs.mockReturnValue(new Set(["codelphi"]));
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM products")) return [[{ id: 4 }]];
      if (sql.includes("SELECT id FROM releases")) return [[{ id: 7 }]];
      if (sql.includes("FROM release_reviewed_items")) return [[{ id: 11, releaseId: 7, featureName: "AI 规格分析与发布变化", description: "内部实现已检查", evidence: [{ path: "lib/analysis.ts", startLine: 10 }] }]];
      return [[]];
    });
  });

  it("returns reviewed audit items for a public demo release", async () => {
    const response = await GET(request(), { params: Promise.resolve({ slug: "codelphi", id: "7" }) });
    expect(response.status).toBe(200);
    const payload = await response.json() as { items: Array<{ kind: string; userImpact: string }> };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ kind: "reviewed", userImpact: "" });
  });

  it("returns 404 for an unknown or cross-product release", async () => {
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM products")) return [[{ id: 4 }]];
      return [[]];
    });
    const response = await GET(request("999"), { params: Promise.resolve({ slug: "codelphi", id: "999" }) });
    expect(response.status).toBe(404);
  });

  it("requires authentication outside public demo products", async () => {
    const response = await GET(request("7", "private"), { params: Promise.resolve({ slug: "private", id: "7" }) });
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});
