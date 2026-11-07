import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "../app/api/products/[slug]/route";
import { updateProductDescription } from "../lib/product-description";
import { updateProductIdentity } from "../lib/product-rename";
import { requireProductAccess } from "../lib/product-access";

vi.mock("../lib/product-description", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/product-description")>();
  return { ...actual, updateProductDescription: vi.fn() };
});
vi.mock("../lib/product-rename", () => ({ updateProductIdentity: vi.fn(), findProductByOldSlug: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("@/lib/product-access", () => ({
  requireProductAccess: vi.fn(async () => ({
    product: { id: 2, slug: "salesbuddy", name: "SalesBuddy", description: "", organizationId: 7 },
    organization: { id: 7, slug: "team", name: "Team", role: "owner" },
    role: "owner",
    via: "organization",
  })),
}));

function patchRequest(slug: string, body: unknown) {
  return PATCH(new NextRequest(`http://localhost/api/products/${slug}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ slug }) });
}

describe("product description route", () => {
  beforeEach(() => {
    vi.mocked(updateProductDescription).mockReset();
    vi.mocked(updateProductIdentity).mockReset();
  });

  it("saves a trimmed manual overview with editor authorization", async () => {
    vi.mocked(updateProductDescription).mockResolvedValue({ id: 3, description: "销售助手" });
    const response = await patchRequest("salesbuddy", { description: "  销售助手  " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "updated", slug: "salesbuddy", name: "SalesBuddy" });
    expect(updateProductDescription).toHaveBeenCalledWith("salesbuddy", 7, "销售助手");
    expect(requireProductAccess).toHaveBeenCalledWith(expect.objectContaining({ sub: "user" }), "salesbuddy", "editor");
    expect(updateProductIdentity).not.toHaveBeenCalled();
  });

  it("rejects invalid payloads and missing products", async () => {
    expect((await patchRequest("salesbuddy", { description: "x".repeat(1001) })).status).toBe(400);
    expect((await patchRequest("salesbuddy", { description: 42 })).status).toBe(400);
    expect((await patchRequest("salesbuddy", null)).status).toBe(400);
    vi.mocked(updateProductDescription).mockResolvedValue(null);
    const missing = await patchRequest("missing", { description: "概况" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "产品不存在或不属于当前工作区" });
  });
});

describe("product rename route", () => {
  beforeEach(() => {
    vi.mocked(updateProductDescription).mockReset();
    vi.mocked(updateProductIdentity).mockReset();
  });

  it("renames name and slug and returns the current address", async () => {
    vi.mocked(updateProductIdentity).mockResolvedValue({ status: "updated", id: 2, name: "CoDelphi", slug: "codelphi" });
    const response = await patchRequest("salesbuddy", { name: " CoDelphi ", slug: "Codelphi" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "updated", slug: "codelphi", name: "CoDelphi" });
    expect(updateProductIdentity).toHaveBeenCalledWith("salesbuddy", 7, { name: "CoDelphi", newSlug: "codelphi" });
    expect(updateProductDescription).not.toHaveBeenCalled();
  });

  it("reports a slug conflict with 409 and missing products with 404", async () => {
    vi.mocked(updateProductIdentity).mockResolvedValue({ status: "slug_conflict" });
    const conflict = await patchRequest("salesbuddy", { slug: "taken" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "该 Slug 已被同工作区其他产品使用" });
    vi.mocked(updateProductIdentity).mockResolvedValue({ status: "not_found" });
    expect((await patchRequest("missing", { name: "新名" })).status).toBe(404);
  });

  it("rejects invalid slug or empty payloads with 400", async () => {
    expect((await patchRequest("salesbuddy", { slug: "Co Delphi!" })).status).toBe(400);
    expect((await patchRequest("salesbuddy", { name: "" })).status).toBe(400);
    expect((await patchRequest("salesbuddy", {})).status).toBe(400);
    expect(updateProductIdentity).not.toHaveBeenCalled();
  });

  it("updates the overview against the new slug after a combined rename", async () => {
    vi.mocked(updateProductIdentity).mockResolvedValue({ status: "updated", id: 2, name: "CoDelphi", slug: "codelphi" });
    vi.mocked(updateProductDescription).mockResolvedValue({ id: 2, description: "概况" });
    const response = await patchRequest("salesbuddy", { name: "CoDelphi", description: " 概况 " });
    expect(response.status).toBe(200);
    expect(updateProductDescription).toHaveBeenCalledWith("codelphi", 7, "概况");
  });
});
