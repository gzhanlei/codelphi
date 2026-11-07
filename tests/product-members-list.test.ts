import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelProductInvitation, listProductMembers, removeProductMember } from "../lib/product-members";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../lib/db", () => ({ getDb: () => ({ execute }), defaultExecute: {} }));

describe("product member roster", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue([[], []]);
  });

  it("joins workspace members, product members, and pending invitations", async () => {
    execute.mockResolvedValueOnce([[{ userId: 1, displayName: "Lei", email: "lei@example.com", role: "owner" }]]);
    execute.mockResolvedValueOnce([[{ userId: 9, displayName: null, email: "partner@example.com", role: "viewer" }]]);
    execute.mockResolvedValueOnce([[{ id: 5, email: "new@example.com", role: "editor", expires_at: new Date("2026-11-14T00:00:00Z") }]]);
    await expect(listProductMembers(3, 7, execute)).resolves.toEqual({
      organizationMembers: [{ userId: 1, displayName: "Lei", email: "lei@example.com", role: "owner" }],
      productMembers: [{ userId: 9, displayName: "", email: "partner@example.com", role: "viewer" }],
      invitations: [{ id: 5, email: "new@example.com", role: "editor", expiresAt: new Date("2026-11-14T00:00:00Z") }],
    });
  });

  it("refuses to remove workspace members and removes only product-scoped rows", async () => {
    execute.mockResolvedValueOnce([[1]]);
    await expect(removeProductMember(3, 7, 1, execute)).resolves.toBe("organization_member");
    expect(execute).toHaveBeenNthCalledWith(1, "SELECT 1 FROM organization_members WHERE organization_id = ? AND user_id = ? LIMIT 1", [7, 1]);
    expect(execute).toHaveBeenCalledTimes(1);

    execute.mockReset();
    execute.mockResolvedValue([[], []]);
    execute.mockResolvedValueOnce([[]]);
    execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    await expect(removeProductMember(3, 7, 9, execute)).resolves.toBe("removed");
    expect(execute).toHaveBeenNthCalledWith(2, "DELETE FROM product_members WHERE product_id = ? AND user_id = ?", [3, 9]);

    execute.mockReset();
    execute.mockResolvedValue([[], []]);
    execute.mockResolvedValueOnce([[]]);
    execute.mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(removeProductMember(3, 7, 42, execute)).resolves.toBe("not_member");
  });

  it("cancels only pending invitations of the product", async () => {
    execute.mockResolvedValueOnce([{ affectedRows: 1 }]);
    await expect(cancelProductInvitation(3, 5, execute)).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith("DELETE FROM product_invitations WHERE id = ? AND product_id = ? AND status = 'pending'", [5, 3]);
    execute.mockReset();
    execute.mockResolvedValue([{ affectedRows: 0 }]);
    await expect(cancelProductInvitation(3, 6, execute)).resolves.toBe(false);
  });
});
