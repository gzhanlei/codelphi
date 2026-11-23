import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/products/[slug]/presentation/route";
import { getSessionUser } from "../lib/session";
import { requireProductAccess } from "../lib/product-access";
import { schedulePresentationRefresh } from "../lib/product-presentation-service";

vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/product-access", () => ({ requireProductAccess: vi.fn() }));
vi.mock("../lib/product-presentation-service", () => ({ schedulePresentationRefresh: vi.fn(async () => ({ outcome: "generating" })), standalonePresentationBilling: () => ({ runId: null, accountId: null, chargeComponent: "main", callKind: "product_presentation" }) }));

function request(slug: string) {
  return POST(new NextRequest(`http://localhost/api/products/${slug}/presentation`, { method: "POST" }), { params: Promise.resolve({ slug }) });
}

describe("product presentation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "user" });
    vi.mocked(requireProductAccess).mockResolvedValue({ product: { id: 12, organizationId: 3 }, organization: { id: 3, slug: "default" }, role: "editor", via: "organization" } as never);
  });

  it("forces a background refresh for editors and returns the scheduling outcome", async () => {
    const response = await request("codelphi");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ outcome: "generating", reason: null });
    expect(schedulePresentationRefresh).toHaveBeenCalledWith({
      productId: 12,
      force: true,
      billing: { runId: null, accountId: null, chargeComponent: "main", callKind: "product_presentation" },
    });
  });

  it("rejects anonymous visitors, non-members and read-only members without scheduling", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect((await request("codelphi")).status).toBe(401);
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "user" });
    vi.mocked(requireProductAccess).mockResolvedValue(null);
    expect((await request("missing")).status).toBe(404);
    vi.mocked(requireProductAccess).mockResolvedValue({ product: { id: 12 }, organization: { id: 3 }, role: "viewer", via: "organization" } as never);
    expect((await request("codelphi")).status).toBe(403);
    expect(schedulePresentationRefresh).not.toHaveBeenCalled();
  });

  it("reports a scheduling failure as 500 without leaking a stack trace", async () => {
    vi.mocked(schedulePresentationRefresh).mockRejectedValueOnce(new Error("db down"));
    const response = await request("codelphi");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "db down" });
  });
});
