import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, loadImpact, resolveStableKey } = vi.hoisted(() => ({ dbExecute: vi.fn(), loadImpact: vi.fn(), resolveStableKey: vi.fn() }));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/spec-file-index", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/spec-file-index")>(),
  loadAffectedScenarios: loadImpact,
}));
vi.mock("../lib/stable-links", () => ({ resolveFeatureByStableKey: resolveStableKey }));
vi.mock("../lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("../lib/public-demo", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/public-demo")>(),
  // 单 slug 的 API 路径没有 org 段，匿名兜底走 legacy 解析；canonical 页面才用 resolvePublicDemoProduct(orgSlug, slug)。
  resolveLegacyPublicDemoProduct: vi.fn(async (slug: string) =>
    slug === "codelphi" ? { id: 1, slug, name: "CoDelphi", organizationId: 7, organizationSlug: "team" } : null),
}));

import { GET } from "../app/api/products/[slug]/impact/route";
import { getSessionUser } from "../lib/session";
import { requireProductAccess } from "../lib/product-access";

const access = {
  product: { id: 1, slug: "codelphi", name: "CoDelphi", description: "d", organizationId: 7 },
  organization: { id: 7, slug: "team", name: "Team", role: "viewer" },
  role: "viewer",
  via: "organization",
} as const;

function request(query = "") {
  return new NextRequest(`https://codelphi.example/api/products/codelphi/impact${query}`);
}

describe("impact preview route (C2 spike)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(requireProductAccess).mockResolvedValue(null);
    dbExecute.mockResolvedValue([[{ id: 9 }], undefined]);
  });

  it("returns affected features and scenarios for the requested files", async () => {
    loadImpact.mockResolvedValue([
      { feature: "QA 回归清单", scenarios: [{ reference: "HP-2", evidencePath: "components/release-card.tsx" }] },
    ]);
    const response = await GET(request("?files=components/release-card.tsx,app/globals.css"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(200);
    const payload = await response.json() as { affected: Array<{ feature: string }>; files: string[] };
    expect(payload.affected).toHaveLength(1);
    expect(payload.affected[0].feature).toBe("QA 回归清单");
    expect(payload.files).toEqual(["components/release-card.tsx", "app/globals.css"]);
  });

  it("resolves the live feature id through the stable-key channel for result links", async () => {
    resolveStableKey.mockResolvedValue(400);
    loadImpact.mockResolvedValue([
      { feature: "AI 规格分析与发布变化", stableKey: "spec-feature:ai-analysis", scenarios: [
        { reference: "EC-1", evidencePath: "instrumentation.ts", context: "服务重启导致分析中断", action: "应用启动", outcome: "恢复在途 run" },
      ] },
    ]);
    const response = await GET(request("?files=instrumentation.ts"), { params: Promise.resolve({ slug: "codelphi" }) });
    const payload = await response.json() as { affected: Array<{ featureId: number | null; scenarios: Array<{ context: string | null }> }> };
    expect(resolveStableKey).toHaveBeenCalledWith(1, "spec-feature:ai-analysis");
    expect(payload.affected[0].featureId).toBe(400);
    expect(payload.affected[0].scenarios[0].context).toBe("服务重启导致分析中断");
  });

  it("degrades to a null feature id when the spec entry has retired from the live spec", async () => {
    resolveStableKey.mockResolvedValue(null);
    loadImpact.mockResolvedValue([
      { feature: "已退役功能", stableKey: "spec-feature:gone", scenarios: [{ reference: "HP-1", evidencePath: "lib/gone.ts", context: null, action: null, outcome: null }] },
    ]);
    const response = await GET(request("?files=lib/gone.ts"), { params: Promise.resolve({ slug: "codelphi" }) });
    const payload = await response.json() as { affected: Array<{ featureId: number | null }> };
    expect(payload.affected[0].featureId).toBeNull();
  });

  it("rejects requests without file paths or over the batch limit", async () => {
    const empty = await GET(request(), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(empty.status).toBe(400);
    const tooMany = await GET(request(`?files=${Array.from({ length: 51 }, (_, i) => `f${i}.ts`).join(",")}`), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(tooMany.status).toBe(400);
  });

  it("keeps non-demo products closed to anonymous callers", async () => {
    const response = await GET(request("?files=lib/ai.ts"), { params: Promise.resolve({ slug: "chandler" }) });
    expect(response.status).toBe(401);
    expect(loadImpact).not.toHaveBeenCalled();
  });

  it("serves logged-in members through their workspace", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "user", email: "pm@example.com" } as never);
    vi.mocked(requireProductAccess).mockResolvedValue(access as never);
    loadImpact.mockResolvedValue([]);
    const response = await GET(request("?files=lib/ai.ts"), { params: Promise.resolve({ slug: "codelphi" }) });
    expect(response.status).toBe(200);
    expect(loadImpact).toHaveBeenCalledWith(9, ["lib/ai.ts"]);
  });
});
