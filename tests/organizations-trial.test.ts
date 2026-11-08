import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUserWorkspace } from "../lib/organizations";
import { grantTrialQuota } from "../lib/billing/core";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));
vi.mock("../lib/billing/core", () => ({ grantTrialQuota: vi.fn(async () => ({ granted: true })) }));

/** ensureUserWorkspace 的注入式 execute mock（对齐 tests/organizations.test.ts 的内存库模式）。 */
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
    if (sql.includes("SELECT id FROM users WHERE chandler_sub")) {
      const [sub] = parameters as [string];
      const user = users.get(sub);
      return [user ? [{ id: user.id }] : []];
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
    if (sql.includes("SELECT organization_id, role FROM organization_invitations")) return [[]];
    if (sql.includes("SELECT product_id, role FROM product_invitations")) return [[]];
    return [{}];
  });
  return { execute, users, organizations, memberships };
}

beforeEach(() => {
  vi.mocked(grantTrialQuota).mockClear();
});

describe("workspace trial authorization (contract M1-T4, P1-3 ownership freeze)", () => {
  it("grants the trial quota to the workspace creator on first bootstrap", async () => {
    const db = createDb();
    const user = { sub: "partner-1", email: "partner@example.com" };
    const org = await ensureUserWorkspace(user, db.execute);
    expect(grantTrialQuota).toHaveBeenCalledWith({ userId: 1, accountId: org.id, source: "workspace_creation" });
  });

  it("re-attempts the grant idempotently on later logins (failed grant self-heal)", async () => {
    const db = createDb();
    const user = { sub: "partner-1", email: "partner@example.com" };
    await ensureUserWorkspace(user, db.execute);
    await ensureUserWorkspace(user, db.execute);
    // 幂等重试：existing 分支同样触发发放尝试，由 trial_grants 唯一性兜底
    expect(grantTrialQuota).toHaveBeenCalledTimes(2);
    expect(grantTrialQuota).toHaveBeenLastCalledWith({ userId: 1, accountId: expect.any(Number), source: "workspace_creation" });
  });

  it("never blocks workspace creation when the grant fails (best-effort, D-no-blocking)", async () => {
    const db = createDb();
    vi.mocked(grantTrialQuota).mockRejectedValueOnce(new Error("billing unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const user = { sub: "partner-2", email: "p2@example.com" };
      const org = await ensureUserWorkspace(user, db.execute);
      expect(org.slug).toBe("u-partner-2");
      expect(getDb).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
