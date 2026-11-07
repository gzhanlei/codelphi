import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, loadImpact } = vi.hoisted(() => ({ dbExecute: vi.fn(), loadImpact: vi.fn() }));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/spec-file-index", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/spec-file-index")>(),
  loadAffectedScenarios: loadImpact,
}));
vi.mock("../lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("../lib/public-demo", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/public-demo")>(),
  resolvePublicDemoProduct: vi.fn(async (slug: string) =>
    slug === "codelphi" ? { id: 1, slug, name: "CoDelphi", organizationId: 7 } : null),
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
