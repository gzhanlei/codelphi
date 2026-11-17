import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SALESBUDDY_DOMAINS, SALESBUDDY_UNGROUPED_IDS, planSalesBuddyBusinessDomainMigration, runSalesBuddyBusinessDomainMigration, type MigrationConnection, type MigrationFeatureRow } from "../scripts/salesbuddy-business-domain-migration";

/** 按计划清单构造 45 个 active 功能（22 个进入分组 + 23 个不分组）。 */
function fullFeatureSet(): MigrationFeatureRow[] {
  const mapped = SALESBUDDY_DOMAINS.flatMap((domain) => domain.featureIds.map((id, index) => ({
    id, name: `功能${id}`, summary: "", parentId: null, source: "generated", active: 1,
    verifiedAt: index % 2 === 0 ? new Date("2026-11-01") : null,
    verifiedBy: index % 2 === 0 ? "维护者" : null,
    lastEditedAt: index % 3 === 0 ? new Date("2026-11-02") : null,
    lastEditedBy: index % 3 === 0 ? "编辑者" : null,
  })));
  const ungrouped = SALESBUDDY_UNGROUPED_IDS.map((id) => ({ id, name: `技术功能${id}`, summary: "", parentId: null, source: "generated", active: 1, verifiedAt: null, verifiedBy: null, lastEditedAt: null, lastEditedBy: null }));
  return [...mapped, ...ungrouped];
}

describe("salesbuddy business domain migration plan (Task 3)", () => {
  it("plans exactly 6 parents, 22 moves and 23 untouched ungrouped features", () => {
    const plan = planSalesBuddyBusinessDomainMigration(fullFeatureSet());
    expect(plan.errors).toEqual([]);
    expect(plan.parents).toHaveLength(6);
    expect(plan.moves).toHaveLength(22);
    expect(plan.ungrouped).toHaveLength(23);
    expect(plan.parents.map((parent) => parent.name)).toEqual(["客户沟通", "客户认知", "商机管理", "承诺管理", "销售执行", "团队管理"]);
  });

  it("records each child's original parent_id, source, verification and edit attribution for rollback", () => {
    const plan = planSalesBuddyBusinessDomainMigration(fullFeatureSet());
    const move71 = plan.moves.find((move) => move.featureId === 71);
    expect(move71).toMatchObject({ featureId: 71, targetDomainKey: "communication", fromParentId: null, source: "generated" });
    // 15118 是 communication 域内第一个 ID（fixture 中有核实与编辑归因）
    expect(plan.snapshot[15118]).toMatchObject({ parentId: null, source: "generated", verifiedBy: "维护者", lastEditedBy: "编辑者" });
  });

  it("aborts on unknown feature IDs without planning any move", () => {
    const missing = fullFeatureSet().filter((feature) => feature.id !== 71);
    const plan = planSalesBuddyBusinessDomainMigration(missing);
    expect(plan.errors.join("\n")).toContain("71");
    expect(plan.moves).toHaveLength(0);
    expect(plan.parents).toHaveLength(0);
  });

  it("aborts when a child already has a parent_id", () => {
    const drifted = fullFeatureSet().map((feature) => (feature.id === 71 ? { ...feature, parentId: 999 } : feature));
    const plan = planSalesBuddyBusinessDomainMigration(drifted);
    expect(plan.errors.join("\n")).toContain("已有父级");
    expect(plan.moves).toHaveLength(0);
  });

  it("aborts when the same feature is targeted by two domains", () => {
    const conflicting = [
      { key: "a", name: "域A", summary: "", featureIds: [71, 72] },
      { key: "b", name: "域B", summary: "", featureIds: [71] },
    ];
    const plan = planSalesBuddyBusinessDomainMigration(fullFeatureSet(), conflicting);
    expect(plan.errors.join("\n")).toContain("71");
    expect(plan.moves).toHaveLength(0);
  });

  it("aborts when the ungrouped list references an unknown feature", () => {
    const plan = planSalesBuddyBusinessDomainMigration(fullFeatureSet(), SALESBUDDY_DOMAINS, [...SALESBUDDY_UNGROUPED_IDS, 424242]);
    expect(plan.errors.join("\n")).toContain("424242");
    expect(plan.moves).toHaveLength(0);
  });
});

// ── Task 4：事务写入、备份与回滚 ──

function fakeConnection(features: MigrationFeatureRow[], failOn?: string) {
  let insertCounter = 1000;
  const statements: Array<{ statement: string; parameters?: unknown[] }> = [];
  const lifecycle: string[] = [];
  const connection: MigrationConnection & { statements: typeof statements; lifecycle: typeof lifecycle } = {
    statements,
    lifecycle,
    async execute(statement: string, parameters?: unknown[]) {
      statements.push({ statement, parameters });
      if (statement.startsWith("SELECT id, slug FROM products")) return [[{ id: 6, slug: "salesbuddy" }], []];
      if (statement.startsWith("SELECT source FROM features")) return [[{ source: "manual" }], []];
      if (statement.startsWith("SELECT id, name, summary")) return [features, []];
      if (statement.startsWith("INSERT INTO features")) return [[{ insertId: ++insertCounter }], []];
      if (failOn && statement.startsWith(failOn)) throw new Error("模拟写入失败");
      return [[], []];
    },
    async beginTransaction() { lifecycle.push("begin"); },
    async commit() { lifecycle.push("commit"); },
    async rollback() { lifecycle.push("rollback"); },
    release() { lifecycle.push("release"); },
  };
  return connection;
}

describe("salesbuddy business domain migration apply (Task 4)", () => {
  it("runs a single transaction: inserts 6 manual parents then moves 22 children, only touching parent_id on updates", async () => {
    const connection = fakeConnection(fullFeatureSet());
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "salesbuddy-backup-"));
    const result = await runSalesBuddyBusinessDomainMigration({ productSlug: "salesbuddy", apply: true, backupDir, connection });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(connection.lifecycle).toEqual(["begin", "commit", "release"]);
    const inserts = connection.statements.filter((entry) => entry.statement.startsWith("INSERT INTO features"));
    expect(inserts).toHaveLength(6);
    for (const insert of inserts) {
      expect(insert.statement).toContain("source, active");
      expect(insert.statement).toContain("'manual'");
      expect(insert.statement).not.toContain("verified");
    }
    const updates = connection.statements.filter((entry) => entry.statement.startsWith("UPDATE features"));
    expect(updates).toHaveLength(22);
    for (const update of updates) {
      // 子功能更新只允许改 parent_id
      expect(update.statement).toBe("UPDATE features SET parent_id = ? WHERE id = ?");
    }
    expect(fs.existsSync(path.join(backupDir, fs.readdirSync(backupDir)[0]))).toBe(true);
  });

  it("rolls back the whole transaction when any step fails and writes nothing", async () => {
    const connection = fakeConnection(fullFeatureSet(), "UPDATE features");
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "salesbuddy-backup-"));
    const result = await runSalesBuddyBusinessDomainMigration({ productSlug: "salesbuddy", apply: true, backupDir, connection });
    expect(result.ok).toBe(false);
    expect(connection.lifecycle).toContain("rollback");
    expect(connection.lifecycle).not.toContain("commit");
  });

  it("records full original values in the backup for restore", async () => {
    const connection = fakeConnection(fullFeatureSet());
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "salesbuddy-backup-"));
    await runSalesBuddyBusinessDomainMigration({ productSlug: "salesbuddy", apply: true, backupDir, connection });
    const backup = JSON.parse(fs.readFileSync(path.join(backupDir, fs.readdirSync(backupDir)[0]), "utf8"));
    expect(backup.productSlug).toBe("salesbuddy");
    expect(backup.children).toHaveLength(22);
    expect(backup.children.find((child: { id: number }) => child.id === 15118)).toMatchObject({ fromParentId: null, source: "generated", verifiedBy: "维护者", lastEditedBy: "编辑者" });
    expect(backup.domains).toHaveLength(6);
  });

  it("refuses to apply when the plan has drift errors (no transaction at all)", async () => {
    const drifted = fullFeatureSet().map((feature) => (feature.id === 71 ? { ...feature, parentId: 999 } : feature));
    const connection = fakeConnection(drifted);
    const result = await runSalesBuddyBusinessDomainMigration({ productSlug: "salesbuddy", apply: true, connection });
    expect(result.ok).toBe(false);
    expect(connection.lifecycle).not.toContain("begin");
    expect(connection.lifecycle).not.toContain("commit");
    expect(connection.statements.filter((entry) => !entry.statement.startsWith("SELECT"))).toHaveLength(0);
  });
});

describe("salesbuddy business domain migration restore (Task 4)", () => {
  function makeBackup(backupDir: string) {
    const backupPath = path.join(backupDir, "salesbuddy-test.json");
    fs.writeFileSync(backupPath, JSON.stringify({
      kind: "salesbuddy-business-domain-migration",
      productSlug: "salesbuddy",
      createdAt: "2026-11-17T00:00:00Z",
      domains: SALESBUDDY_DOMAINS.map((domain) => ({ key: domain.key, name: domain.name, summary: domain.summary })),
      children: [{ id: 71, name: "功能71", fromParentId: null, targetDomainName: "客户沟通", source: "generated", verifiedAt: null, verifiedBy: null, lastEditedAt: null, lastEditedBy: null }],
    }));
    return backupPath;
  }

  it("restores original parent_id and soft-disables the created parents without deleting anything", async () => {
    // 迁移后状态：71 的父级是名为「客户沟通」的 manual 父节点
    const migrated = fullFeatureSet().map((feature) => (feature.id === 71 ? { ...feature, parentId: 1001 } : feature));
    migrated.push({ id: 1001, name: "客户沟通", summary: "", parentId: null, source: "manual", active: 1, verifiedAt: null, verifiedBy: null, lastEditedAt: null, lastEditedBy: null });
    const connection = fakeConnection(migrated);
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "salesbuddy-restore-"));
    const backupPath = makeBackup(backupDir);
    const result = await runSalesBuddyBusinessDomainMigration({ productSlug: "salesbuddy", apply: true, restoreFrom: backupPath, backupDir, connection });
    expect(result.ok).toBe(true);
    expect(connection.lifecycle).toEqual(["begin", "commit", "release"]);
    const updates = connection.statements.filter((entry) => entry.statement.startsWith("UPDATE"));
    expect(updates.some((entry) => JSON.stringify(entry.parameters) === JSON.stringify([null, 71]))).toBe(true);
    expect(updates.some((entry) => entry.statement.includes("active = 0") && JSON.stringify(entry.parameters).includes("客户沟通"))).toBe(true);
    expect(connection.statements.some((entry) => entry.statement.startsWith("DELETE"))).toBe(false);
  });

  it("refuses restore when the backup file is missing", async () => {
    const connection = fakeConnection(fullFeatureSet());
    const result = await runSalesBuddyBusinessDomainMigration({ productSlug: "salesbuddy", apply: true, restoreFrom: "/nonexistent/backup.json", connection });
    expect(result.ok).toBe(false);
    expect(result.errors.join("")).toContain("备份");
    expect(connection.lifecycle).not.toContain("begin");
    expect(connection.lifecycle).not.toContain("commit");
  });

  it("refuses restore when the product does not match the backup", async () => {
    const connection = fakeConnection(fullFeatureSet());
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "salesbuddy-restore-"));
    const backupPath = makeBackup(backupDir);
    const result = await runSalesBuddyBusinessDomainMigration({ productSlug: "other-product", apply: true, restoreFrom: backupPath, connection });
    expect(result.ok).toBe(false);
    expect(result.errors.join("")).toContain("产品");
    expect(connection.lifecycle).not.toContain("begin");
    expect(connection.lifecycle).not.toContain("commit");
  });

  it("refuses restore when current parent-child relations have drifted from the backup", async () => {
    // 71 的当前父级不是备份记录的目标域父节点 → 漂移，拒绝恢复
    const drifted = fullFeatureSet().map((feature) => (feature.id === 71 ? { ...feature, parentId: 7777 } : feature));
    drifted.push({ id: 7777, name: "别的域", summary: "", parentId: null, source: "manual", active: 1, verifiedAt: null, verifiedBy: null, lastEditedAt: null, lastEditedBy: null });
    const connection = fakeConnection(drifted);
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "salesbuddy-restore-"));
    const backupPath = makeBackup(backupDir);
    const result = await runSalesBuddyBusinessDomainMigration({ productSlug: "salesbuddy", apply: true, restoreFrom: backupPath, connection });
    expect(result.ok).toBe(false);
    expect(result.errors.join("")).toContain("漂移");
    expect(connection.lifecycle).not.toContain("begin");
    expect(connection.lifecycle).not.toContain("commit");
  });
});
