import { describe, expect, it, vi } from "vitest";
import { ensureUserWorkspace, listUserOrganizations, requireOrganization } from "../lib/organizations";

function createDb() {
  const users = new Map<string, { id: number; sub: string }>();
  const organizations = new Map<string, { id: number; slug: string; name: string }>();
  const memberships = new Set<string>();
  const execute = vi.fn(async (sql: string, parameters: Array<string | number | null>) => {
    if (sql.includes("INSERT INTO users")) {
      const [sub] = parameters as [string];
      if (!users.has(sub)) users.set(sub, { id: users.size + 1, sub });
      return [{ insertId: users.get(sub)!.id }];
    }
    if (sql.includes("INSERT INTO organizations") && !sql.includes("organization_members")) {
      const [slug, name] = parameters as [string, string];
      if (!organizations.has(slug)) organizations.set(slug, { id: organizations.size + 1, slug, name });
      return [{ insertId: organizations.get(slug)!.id }];
    }
    if (sql.includes("INSERT INTO organization_members")) {
      const [slug, sub] = parameters as [string, string];
      memberships.add(`${slug}:${sub}`);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SELECT o.id, o.slug, o.name, m.role FROM organizations o JOIN organization_members")) {
      const [sub, slug] = parameters as [string, string];
      return [[...organizations.values()].filter((org) => org.slug === slug && memberships.has(`${org.slug}:${sub}`)).map((org) => ({ ...org, role: "owner" }))];
    }
    if (sql.includes("SELECT o.id, o.slug, o.name, m.role FROM organization_members m")) {
      const [sub] = parameters as [string];
      return [[...organizations.values()].filter((org) => memberships.has(`${org.slug}:${sub}`)).map((org) => ({ ...org, role: "owner" }))];
    }
    return [{}];
  });
  return { execute, users, organizations, memberships };
}

describe("multi-tenant workspaces", () => {
  it("bootstraps a personal organization for a new user", async () => {
    const db = createDb();
    const user = { sub: "partner-1", email: "partner@example.com" };
    const org = await ensureUserWorkspace(user, db.execute);
    expect(org).toMatchObject({ slug: "u-partner-1", role: "owner" });
    expect(org.id).toBeGreaterThan(0);
    expect(db.organizations.get("u-partner-1")).toBeDefined();
    expect(db.memberships.has("u-partner-1:partner-1")).toBe(true);
    expect(await listUserOrganizations(user, db.execute)).toHaveLength(1);
  });

  it("is idempotent and rejects non-members from organizations they do not own", async () => {
    const db = createDb();
    const user = { sub: "partner-1", email: "partner@example.com" };
    await ensureUserWorkspace(user, db.execute);
    await ensureUserWorkspace(user, db.execute);
    expect(await listUserOrganizations(user, db.execute)).toHaveLength(1);
    const organization = await requireOrganization(user, "viewer", null, db.execute);
    expect(organization.slug).toBe("u-partner-1");
    await expect(requireOrganization(user, "owner", null, db.execute)).resolves.toMatchObject({ role: "owner" });
    expect(await requireOrganization(user, "viewer", "u-partner-1", db.execute)).toMatchObject({ slug: "u-partner-1", role: "owner" });
    expect(await requireOrganization(user, "viewer", "missing", db.execute)).toMatchObject({ slug: "u-partner-1" });
  });
});
