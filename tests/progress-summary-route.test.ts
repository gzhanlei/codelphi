import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, loadSummary } = vi.hoisted(() => ({ dbExecute: vi.fn(), loadSummary: vi.fn() }));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/progress-summary", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/progress-summary")>(),
  loadRecentReleasesWithChanges: loadSummary,
}));
vi.mock("../lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("../lib/public-demo", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/public-demo")>(),
  resolvePublicDemoProduct: vi.fn(async (slug: string) =>
    slug === "codelphi" ? { id: 1, slug, name: "CoDelphi", organizationId: 7 } : null),
}));

import { GET } from "../app/api/products/[slug]/progress-summary/route";
import { getSessionUser } from "../lib/session";
import { requireProductAccess } from "../lib/product-access";

const access = {
  product: { id: 1, slug: "codelphi", name: "CoDelphi", description: "d", organizationId: 7 },
  organization: { id: 7, slug: "team", name: "Team", role: "viewer" },
  role: "viewer",
  via: "organization",
} as const;

function request(query = "") {
  return new NextRequest(`https://codelphi.example/api/products/codelphi/progress-summary${query}`);
}

describe("progress summary route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(requireProductAccess).mockResolvedValue(null);
  });

  it("serves an anonymous markdown summary for the public demo product", async () => {
    loadSummary.mockResolvedValue([
      { id: 5, title: "t", summary: "s", sha: "abc1234", url: "u", committedAt: new Date("2026-11-07T08:00:00Z"), total: 2, added: 1, changed: 1, removed: 0 },
    ]);
    const response = await GET(request("?days=7"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(await response.text()).toContain("# 进展摘要 · CoDelphi");
    expect(loadSummary).toHaveBeenCalledWith(1, 7);
  });

  it("defaults to a 7-day window and caps the range", async () => {
    loadSummary.mockResolvedValue([]);
    await GET(request(), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(loadSummary).toHaveBeenCalledWith(1, 7);
    const capped = await GET(request("?days=500"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(capped.status).toBe(400);
  });

  it("keeps non-demo products closed to anonymous callers", async () => {
    const response = await GET(request(), { params: Promise.resolve({ slug: "chandler" }) });
    expect(response.status).toBe(401);
    expect(loadSummary).not.toHaveBeenCalled();
  });

  it("serves logged-in members through their workspace", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "user", email: "pm@example.com" } as never);
    vi.mocked(requireProductAccess).mockResolvedValue(access as never);
    loadSummary.mockResolvedValue([]);
    const response = await GET(request(), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(200);
    expect(loadSummary).toHaveBeenCalledWith(1, 7);
  });
});
