import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as removeMemberRoute } from "../app/api/products/[slug]/members/[userId]/route";
import { DELETE as cancelInvitationRoute } from "../app/api/products/[slug]/invitations/[id]/route";
import { GET as listMembersRoute, POST as inviteMemberRoute } from "../app/api/products/[slug]/members/route";
import { cancelProductInvitation, inviteProductMember, listProductMembers, removeProductMember } from "../lib/product-members";
import { requireProductAccess, type ProductAccess } from "@/lib/product-access";

vi.mock("../lib/product-members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/product-members")>();
  return { ...actual, inviteProductMember: vi.fn(), listProductMembers: vi.fn(), removeProductMember: vi.fn(), cancelProductInvitation: vi.fn() };
});
vi.mock("@/lib/session", () => ({ requireSessionUser: vi.fn(async () => ({ sub: "user" })) }));
vi.mock("@/lib/product-access", () => ({ requireProductAccess: vi.fn() }));

function access(overrides: Partial<ProductAccess>): ProductAccess {
  return {
    product: { id: 2, slug: "salesbuddy", name: "SalesBuddy", description: "", organizationId: 7 },
    organization: { id: 7, slug: "team", name: "Team", role: "owner" },
    role: "owner",
    via: "organization",
    ...overrides,
  };
}

function routeRequest(method: string, path: string, body?: unknown) {
  const url = `http://localhost${path}`;
  return method === "DELETE"
    ? new NextRequest(url, { method })
    : new NextRequest(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

const listCtx = { params: Promise.resolve({ slug: "salesbuddy" }) };
const removeCtx = { params: Promise.resolve({ slug: "salesbuddy", userId: "9" }) };
const cancelCtx = { params: Promise.resolve({ slug: "salesbuddy", id: "5" }) };

describe("product members route", () => {
  beforeEach(() => {
    vi.mocked(requireProductAccess).mockReset();
    vi.mocked(inviteProductMember).mockReset();
    vi.mocked(listProductMembers).mockReset();
    vi.mocked(removeProductMember).mockReset();
    vi.mocked(cancelProductInvitation).mockReset();
  });

  it("lists the roster for any product member", async () => {
    vi.mocked(requireProductAccess).mockResolvedValue(access({ role: "viewer" }));
    vi.mocked(listProductMembers).mockResolvedValue({ organizationMembers: [], productMembers: [], invitations: [] });
    const response = await listMembersRoute(routeRequest("GET", "/api/products/salesbuddy/members"), listCtx);
    expect(response.status).toBe(200);
    expect(listProductMembers).toHaveBeenCalledWith(2, 7);
  });

  it("lets only workspace owners invite product members", async () => {
    vi.mocked(requireProductAccess).mockResolvedValue(access({}));
    vi.mocked(inviteProductMember).mockResolvedValue({ status: "invitation_pending", email: "new@example.com", role: "editor", inviteUrl: "https://codelphi.com/invitations/accept?token=x", emailSent: false });
    const response = await inviteMemberRoute(routeRequest("POST", "/api/products/salesbuddy/members", { email: "new@example.com", role: "editor" }), listCtx);
    expect(response.status).toBe(201);
    expect(inviteProductMember).toHaveBeenCalledWith(expect.objectContaining({ sub: "user" }), expect.objectContaining({ id: 7 }), expect.objectContaining({ id: 2 }), { email: "new@example.com", role: "editor" }, expect.anything());
    expect(await response.json()).toMatchObject({ status: "invitation_pending" });

    vi.mocked(requireProductAccess).mockResolvedValue(access({ role: "editor", organization: { id: 7, slug: "team", name: "Team", role: "editor" } }));
    expect((await inviteMemberRoute(routeRequest("POST", "/api/products/salesbuddy/members", { email: "new@example.com", role: "editor" }), listCtx)).status).toBe(403);
    vi.mocked(requireProductAccess).mockResolvedValue(access({ role: "editor", via: "product", organization: { id: 7, slug: "team", name: "Team", role: "editor" } }));
    expect((await inviteMemberRoute(routeRequest("POST", "/api/products/salesbuddy/members", { email: "new@example.com", role: "editor" }), listCtx)).status).toBe(403);
  });

  it("removes only product-scoped members for workspace owners", async () => {
    vi.mocked(requireProductAccess).mockResolvedValue(access({}));
    vi.mocked(removeProductMember).mockResolvedValue("removed");
    expect((await removeMemberRoute(routeRequest("DELETE", "/api/products/salesbuddy/members/9"), removeCtx)).status).toBe(200);
    vi.mocked(removeProductMember).mockResolvedValue("organization_member");
    expect((await removeMemberRoute(routeRequest("DELETE", "/api/products/salesbuddy/members/1"), removeCtx)).status).toBe(400);
    vi.mocked(removeProductMember).mockResolvedValue("not_member");
    expect((await removeMemberRoute(routeRequest("DELETE", "/api/products/salesbuddy/members/42"), removeCtx)).status).toBe(404);
    vi.mocked(requireProductAccess).mockResolvedValue(access({ role: "editor", organization: { id: 7, slug: "team", name: "Team", role: "editor" } }));
    expect((await removeMemberRoute(routeRequest("DELETE", "/api/products/salesbuddy/members/9"), removeCtx)).status).toBe(403);
  });

  it("cancels pending invitations for workspace owners", async () => {
    vi.mocked(requireProductAccess).mockResolvedValue(access({}));
    vi.mocked(cancelProductInvitation).mockResolvedValue(true);
    expect((await cancelInvitationRoute(routeRequest("DELETE", "/api/products/salesbuddy/invitations/5"), cancelCtx)).status).toBe(200);
    vi.mocked(cancelProductInvitation).mockResolvedValue(false);
    expect((await cancelInvitationRoute(routeRequest("DELETE", "/api/products/salesbuddy/invitations/5"), cancelCtx)).status).toBe(404);
  });
});
