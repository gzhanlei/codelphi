import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUserWorkspace, listUserOrganizations, requireOrganization } from "../lib/organizations";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn(), defaultExecute: vi.fn() }));

function createDb() {
  const users = new Map<string, number>();
  const organizations = new Map<number, { id: number; slug: string; name: string }>();
  const memberships = new Set<string>();
  const billingRows = new Set<number>();
  const log: Array<{ source: string; sql: string; params: unknown[]; ok: boolean }> = [];
  let orgSeq = 0;
  const execute = vi.fn(async (sql: string, parameters: Array<string | number | null>) => {
    log.push({ source: "exec", sql, params: parameters, ok: true });
    if (sql.includes("INSERT IGNORE INTO billing_accounts")) {
      const [orgId] = parameters as [number];
      billingRows.add(orgId);
      return [{ affectedRows: 1 }];
    }
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
  return { execute, users, organizations, memberships, billingRows, log };
}

/**
 * grantTrialQuota 内部的 runInBillingTransaction 走 getDb 连接。按 billingRows 是否含
 * 账户 id 忠实模拟钱包外键（billing_wallets_account_fk → billing_accounts）：缺行 = 
 * 钱包插入失败、发放整事务回滚（无 committed 授予，重试不判 DUP）。共享有序日志。
 */
function billingDb(
  log: Array<{ source: string; sql: string; params: unknown[]; ok: boolean }>,
  billingRows: Set<number>,
) {
  let committedGrant = false;
  return {
    execute: vi.fn(),
    getConnection: vi.fn(async () => ({
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("INSERT INTO billing_quota_wallets") && !billingRows.has(Number(params[0]))) {
          log.push({ source: "billing", sql, params, ok: false });
          throw Object.assign(new Error("Cannot add or update a child row: a foreign key constraint fails"), { code: "ER_NO_REFERENCED_ROW_2" });
        }
        log.push({ source: "billing", sql, params, ok: true });
        if (sql.includes("INSERT INTO trial_grants")) {
          if (committedGrant) throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("INSERT INTO billing_quota_wallets")) {
          committedGrant = true;
          return [{ insertId: 31 }];
        }
        return [[], []];
      }),
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(),
    })),
  };
}

beforeEach(() => {
  vi.mocked(getDb).mockReset();
});

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

  it("ensures the billing account row before the trial grant for a new workspace (P0: trial wallet FK dependency)", async () => {
    const db = createDb();
    vi.mocked(getDb).mockReturnValue(billingDb(db.log, db.billingRows) as never);
    const user = { sub: "partner-p0", email: "p0@example.com" };
    const org = await ensureUserWorkspace(user, db.execute);
    expect(org.id).toBeGreaterThan(0);
    // 账务账户行被创建（migration 031 后新建组织的缺失面），且先于 trial 钱包插入
    expect(db.billingRows.has(org.id)).toBe(true);
    const rowIdx = db.log.findIndex((e) => e.sql.includes("INSERT IGNORE INTO billing_accounts"));
    const walletInsert = db.log.find((e) => e.sql.includes("INSERT INTO billing_quota_wallets") && e.ok);
    expect(rowIdx).toBeGreaterThan(-1);
    expect(walletInsert).toBeDefined();
    expect(db.log.indexOf(walletInsert!)).toBeGreaterThan(rowIdx);
    expect(db.log[rowIdx].params).toEqual([org.id]);
    // 发放真正成功（不再被 best-effort 吞掉）：trial 钱包按用户幂等键落库
    expect(walletInsert!.params[2]).toBe("trial:1");
  });

  it("self-heals an existing workspace missing the billing account row on the next login", async () => {
    const db = createDb();
    const user = { sub: "partner-p0", email: "p0@example.com" };
    // 手工播种一个 031 后注册、修复部署前的坏号工作区：有组织、有成员、无账务账户行
    db.users.set(user.sub, 1);
    const brokenOrgId = 99;
    db.organizations.set(brokenOrgId, { id: brokenOrgId, slug: "u-broken0", name: "w" });
    db.memberships.add(`${brokenOrgId}:1`);
    vi.mocked(getDb).mockReturnValue(billingDb(db.log, db.billingRows) as never);
    const org = await ensureUserWorkspace(user, db.execute);
    // 走既有工作区路径（不重建组织），但账务行兜底 + 发放重试都执行且有序
    expect(org.id).toBe(brokenOrgId);
    expect(db.log.filter((e) => e.source === "exec" && e.sql.includes("INSERT INTO organizations") && !e.sql.includes("organization_members"))).toHaveLength(0);
    expect(db.billingRows.has(brokenOrgId)).toBe(true);
    const rowIdx = db.log.findIndex((e) => e.sql.includes("INSERT IGNORE INTO billing_accounts"));
    const walletInsert = db.log.find((e) => e.sql.includes("INSERT INTO billing_quota_wallets") && e.ok);
    expect(rowIdx).toBeGreaterThan(-1);
    expect(walletInsert).toBeDefined();
    expect(db.log.indexOf(walletInsert!)).toBeGreaterThan(rowIdx);
    expect(db.log[rowIdx].params).toEqual([brokenOrgId]);
  });
});
