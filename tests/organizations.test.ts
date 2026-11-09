import { describe, expect, it, vi } from "vitest";
import { ensureUserWorkspace, listUserOrganizations, requireOrganization } from "../lib/organizations";

function createDb() {
  const users = new Map<string, number>();
  const organizations = new Map<number, { id: number; slug: string; name: string }>();
  const memberships = new Set<string>();
  let orgSeq = 0;
  const execute = vi.fn(async (sql: string, parameters: Array<string | number | null>) => {
    if (sql.includes("INSERT INTO users")) {
      const [sub] = parameters as [string];
      if (!users.has(sub)) users.set(sub, users.size + 1);
      return [{ insertId: users.get(sub)! }];
    }
    if (sql.startsWith("SELECT id FROM users")) {
      const [sub] = parameters as [string];
      return [users.has(sub) ? [{ id: users.get(sub)! }] : []];
    }
    if (sql.includes("INSERT INTO organizations") && !sql.includes("organization_members")) {
      const [slug, name] = parameters as [string, string];
      const id = ++orgSeq;
      organizations.set(id, { id, slug, name });
      return [{ insertId: id }];
    }
    if (sql.startsWith("SELECT id FROM organizations")) {
      const [slug] = parameters as [string];
      const found = [...organizations.values()].find((org) => org.slug === slug);
      return [found ? [found] : []];
    }
    if (sql.includes("INSERT INTO organization_members (organization_id, user_id, role) VALUES")) {
      const [orgId, userId] = parameters as [number, number];
      memberships.add(`${orgId}:${userId}`);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("WHERE u.chandler_sub = ? AND o.slug LIKE ?")) {
      const [sub] = parameters as [string];
      const rows = [...organizations.values()]
        .filter((org) => org.slug.startsWith("u-") && users.get(sub) !== undefined && memberships.has(`${org.id}:${users.get(sub)!}`))
        .map((org) => ({ ...org, role: "owner" }));
      return [sql.includes("DESC") ? rows.reverse() : rows];
    }
    if (sql.includes("WHERE u.chandler_sub = ? AND o.slug = ?")) {
      const [sub, slug] = parameters as [string, string];
      const rows = [...organizations.values()]
        .filter((org) => org.slug === slug && users.get(sub) !== undefined && memberships.has(`${org.id}:${users.get(sub)!}`))
        .map((org) => ({ ...org, role: "owner" }));
      return [rows];
    }
    if (sql.includes("SELECT o.id, o.slug, o.name, m.role FROM organization_members m")) {
      const [sub] = parameters as [string];
      const rows = [...organizations.values()]
        .filter((org) => users.get(sub) !== undefined && memberships.has(`${org.id}:${users.get(sub)!}`))
        .map((org) => ({ ...org, role: "owner" }));
      return [rows];
    }
    if (sql.includes("SELECT organization_id, role FROM organization_invitations")) return [[]];
    if (sql.includes("SELECT product_id, role FROM product_invitations")) return [[]];
    return [{}];
  });
  return { execute, users, organizations, memberships };
}

describe("multi-tenant workspaces", () => {
  it("bootstraps a personal organization for a new user with a non-identifying slug", async () => {
    const db = createDb();
    const user = { sub: "partner-1", email: "partner@example.com" };
    const org = await ensureUserWorkspace(user, db.execute);
    expect(org.slug).toMatch(/^u-[0-9a-f]{10}$/);
    expect(org).toMatchObject({ role: "owner" });
    expect(org.id).toBeGreaterThan(0);
    const slug = org.slug;
    expect(db.organizations.get(org.id)?.slug).toBe(slug);
    expect(slug).not.toContain("partner-1");
    expect(await listUserOrganizations(user, db.execute)).toHaveLength(1);
  });

  it("is idempotent and rejects non-members from organizations they do not own", async () => {
    const db = createDb();
    const user = { sub: "partner-1", email: "partner@example.com" };
    const first = await ensureUserWorkspace(user, db.execute);
    const second = await ensureUserWorkspace(user, db.execute);
    expect(second.slug).toBe(first.slug);
    expect(await listUserOrganizations(user, db.execute)).toHaveLength(1);
    const organization = await requireOrganization(user, "viewer", null, db.execute);
    expect(organization.slug).toBe(first.slug);
    await expect(requireOrganization(user, "owner", null, db.execute)).resolves.toMatchObject({ role: "owner" });
    expect(await requireOrganization(user, "viewer", first.slug, db.execute)).toMatchObject({ slug: first.slug, role: "owner" });
    expect(await requireOrganization(user, "viewer", "missing", db.execute)).toMatchObject({ slug: first.slug });
  });
});
