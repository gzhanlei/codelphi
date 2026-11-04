import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "../app/api/products/[slug]/route";
import { ProductRemovalError, removeProduct } from "../lib/product-removal";
import { requireOrganization } from "../lib/organizations";

vi.mock("../lib/product-removal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/product-removal")>();
  return { ...actual, removeProduct: vi.fn() };
});
vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("@/lib/organizations", () => ({ requireOrganization: vi.fn(async () => ({ id: 7, role: "owner" })) }));

function request(slug: string) {
  return DELETE(new NextRequest(`http://localhost/api/products/${slug}`, { method: "DELETE" }), { params: Promise.resolve({ slug }) });
}

describe("product removal route", () => {
  beforeEach(() => vi.mocked(removeProduct).mockReset());

  it("removes a product with editor authorization", async () => {
    vi.mocked(removeProduct).mockResolvedValue({ status: "deleted", artifactsRemoved: true });
    const response = await request("namedict");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
    expect(removeProduct).toHaveBeenCalledWith("namedict", 7);
    expect(requireOrganization).toHaveBeenCalledWith(expect.objectContaining({ sub: "user" }), "editor");
  });

  it("maps missing products and active analyses", async () => {
    vi.mocked(removeProduct).mockRejectedValueOnce(new ProductRemovalError(404, "产品不存在或不属于当前工作区"));
    expect((await request("missing")).status).toBe(404);
    vi.mocked(removeProduct).mockRejectedValueOnce(new ProductRemovalError(409, "当前产品正在分析，请完成后再移除"));
    const active = await request("namedict");
    expect(active.status).toBe(409);
    expect(await active.json()).toEqual({ error: "当前产品正在分析，请完成后再移除" });
  });

});
