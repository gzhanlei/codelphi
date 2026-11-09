import { beforeEach, describe, expect, it, vi } from "vitest";
import LegacyProductPage from "../app/products/[slug]/page";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess, type ProductAccess } from "@/lib/product-access";
import { currentOrganization } from "@/lib/organizations";
import { findProductByOldSlug } from "@/lib/product-rename";
import { resolveLegacyPublicDemoProduct } from "@/lib/public-demo";

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
}));
vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/product-access", () => ({ requireProductAccess: vi.fn(async () => null) }));
vi.mock("@/lib/organizations", () => ({ currentOrganization: vi.fn(async () => ({ id: 1, slug: "default", name: "Default", role: "owner" })) }));
vi.mock("@/lib/product-rename", () => ({ findProductByOldSlug: vi.fn(async () => null) }));
vi.mock("@/lib/public-demo", () => ({ resolveLegacyPublicDemoProduct: vi.fn(async () => null) }));

function access(orgSlug: string): ProductAccess {
  return {
    product: { id: 2, slug: "salesbuddy", name: "SalesBuddy", description: "", organizationId: 1 },
    organization: { id: 1, slug: orgSlug, name: "Default", role: "viewer" },
    role: "viewer",
    via: "organization",
  };
}

async function render(slug: string, searchParams: Record<string, string> = {}) {
  return await LegacyProductPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(searchParams) });
}

describe("legacy one-segment product address redirector", () => {
  beforeEach(() => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(requireProductAccess).mockResolvedValue(null);
    vi.mocked(currentOrganization).mockResolvedValue({ id: 1, slug: "default", name: "Default", role: "owner" });
    vi.mocked(findProductByOldSlug).mockResolvedValue(null);
    vi.mocked(resolveLegacyPublicDemoProduct).mockResolvedValue(null);
  });

  it("redirects to the canonical org-qualified address of the accessible product, preserving the query", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "u1", email: "u1@example.com", name: "" });
    vi.mocked(requireProductAccess).mockResolvedValue(access("default"));
    await expect(render("salesbuddy", { view: "spec" })).rejects.toThrow("NEXT_REDIRECT:/products/default/salesbuddy?view=spec");
    expect(requireProductAccess).toHaveBeenCalledWith(expect.objectContaining({ sub: "u1" }), "salesbuddy");
  });

  it("redirects to a renamed product's canonical address via the slug history, scoped to the caller's workspaces", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "u1", email: "u1@example.com", name: "" });
    vi.mocked(findProductByOldSlug).mockResolvedValue({ slug: "codelphi", orgSlug: "acme" });
    await expect(render("radar")).rejects.toThrow("NEXT_REDIRECT:/products/acme/codelphi");
    expect(findProductByOldSlug).toHaveBeenCalledWith("radar", { userSub: "u1", preferredOrgId: 1 });
  });

  it("sends signed-in members without access to a public demo to its canonical address", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "u1", email: "u1@example.com", name: "" });
    vi.mocked(resolveLegacyPublicDemoProduct).mockResolvedValue({ id: 9, slug: "reporadar", name: "Radar", organizationId: 3, organizationSlug: "default" });
    await expect(render("reporadar", { view: "changes" })).rejects.toThrow("NEXT_REDIRECT:/products/default/reporadar?view=changes");
  });

  it("keeps 404 for signed-in users with no resolution at all", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ sub: "u1", email: "u1@example.com", name: "" });
    await expect(render("missing")).rejects.toThrow("NOT_FOUND");
  });

  it("redirects anonymous visitors of a public demo to its canonical address", async () => {
    vi.mocked(resolveLegacyPublicDemoProduct).mockResolvedValue({ id: 9, slug: "reporadar", name: "Radar", organizationId: 3, organizationSlug: "default" });
    await expect(render("reporadar")).rejects.toThrow("NEXT_REDIRECT:/products/default/reporadar");
  });

  it("redirects anonymous visitors of non-demo products to the login page", async () => {
    await expect(render("salesbuddy")).rejects.toThrow("NEXT_REDIRECT:/login");
  });
});
