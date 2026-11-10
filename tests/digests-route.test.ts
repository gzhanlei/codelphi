import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbExecute, enforceExportRateLimit } = vi.hoisted(() => ({ dbExecute: vi.fn(), enforceExportRateLimit: vi.fn() }));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: dbExecute }) }));
vi.mock("../lib/session", () => ({ getSessionUser: vi.fn(), requireSessionUser: vi.fn() }));
vi.mock("../lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("../lib/rate-limit", () => ({ enforceExportRateLimit }));
vi.mock("../lib/env", () => ({
  requiredEnv: vi.fn((name: string) => { if (name === "SESSION_SECRET") return "test-secret"; throw new Error(`${name} is not configured`); }),
  appUrl: vi.fn(() => "https://codelphi.example"),
  chandlerBaseUrl: vi.fn(() => "https://api.chandler.example"),
}));

import { GET } from "../app/api/products/[slug]/digests/latest/route";
import { getSessionUser } from "../lib/session";
import { requireProductAccess } from "../lib/product-access";

const access = {
  product: { id: 1, slug: "salesbuddy", name: "SalesBuddy", description: "d", organizationId: 7 },
  organization: { id: 7, slug: "team", name: "Team", role: "viewer" },
  role: "viewer",
  via: "organization",
} as const;

const digestRow = {
  periodStart: "2026-11-04",
  periodEnd: "2026-11-10",
  createdAt: new Date("2026-11-11T01:00:00Z"),
  contentJson: JSON.stringify({
    period: { start: "2026-11-04", end: "2026-11-10" },
    changes: [{ id: 11, kind: "added", entityType: "scenario", featureName: "助理聊天", scenarioReference: "HP-2", summary: "URL 可点", highlightType: "News", evidencePaths: ["lib/chat.ts"], releaseTitle: "t", releaseUrl: "u", specChangeId: 11 }],
    audiences: { support: [{ id: 11 }], sales: [], marketing: [{ id: 11 }] },
  }),
};

describe("digests latest route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceExportRateLimit.mockResolvedValue(null);
    vi.mocked(getSessionUser).mockResolvedValue({ id: 3, sub: "user-1", email: "a@b.c", name: "A", picture: "" } as never);
    vi.mocked(requireProductAccess).mockResolvedValue(access as never);
  });

  it("returns the latest digest with deterministic markdown and audience counts", async () => {
    dbExecute.mockResolvedValue([[digestRow], []]);
    const response = await GET(new NextRequest("https://codelphi.example/api/products/salesbuddy/digests/latest"), { params: Promise.resolve({ slug: "salesbuddy" }) });
    const data = await response.json();
    expect(data.digest.periodStart).toBe("2026-11-04");
    expect(data.digest.markdown).toContain("SalesBuddy 周期行为摘要（2026-11-04 ~ 2026-11-10）");
    expect(data.digest.changes).toBe(1);
    expect(data.digest.audiences).toEqual({ support: 1, sales: 0, marketing: 1 });
  });

  it("returns null digest when none stored and 401 when anonymous", async () => {
    dbExecute.mockResolvedValue([[], []]);
    const empty = await GET(new NextRequest("https://codelphi.example/api/products/salesbuddy/digests/latest"), { params: Promise.resolve({ slug: "salesbuddy" }) });
    expect((await empty.json()).digest).toBeNull();
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const anonymous = await GET(new NextRequest("https://codelphi.example/api/products/salesbuddy/digests/latest"), { params: Promise.resolve({ slug: "salesbuddy" }) });
    expect(anonymous.status).toBe(401);
  });
});
