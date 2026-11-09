import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUserWorkspace } from "../lib/organizations";
import { grantTrialQuota } from "../lib/billing/core";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));
vi.mock("../lib/billing/core", () => ({ grantTrialQuota: vi.fn(async () => ({ granted: true })) }));

/** ensureUserWorkspace 的注入式 execute mock（对齐 tests/organizations.test.ts 的内存库模式）。 */
function createDb() {
  const users = new Map<string, number>();
  const organizations = new Map<number, { id: number; slug: string; name: string }>();
  const memberships = new Set<string>();
  let orgSeq = 0;
  const ownedPersonalOrgs = (sub: string) =>
    [...organizations.values()].filter((org) => org.slug.startsWith("u-") && users.has(sub) && memberships.has(`${org.id}:${users.get(sub)!}`));
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
      const rows = ownedPersonalOrgs(sub).map((org) => ({ ...org, role: "owner" }));
      return [sql.includes("DESC") ? rows.reverse() : rows];
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
      expect(org.slug).toMatch(/^u-[0-9a-f]{10}$/);
      expect(getDb).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
