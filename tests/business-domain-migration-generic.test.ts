import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDomainsDocument, planBusinessDomainMigration, runBusinessDomainMigration, type MigrationConnection, type MigrationFeatureRow } from "../scripts/salesbuddy-business-domain-migration";

// ── 通用化（2026-11-17 追加）：任意产品按审核后的候选 JSON 落地业务域 ──

const feature = (id: number, name: string, parentId: number | null = null, source = "generated"): MigrationFeatureRow =>
  ({ id, name, summary: "", parentId, source, active: 1, verifiedAt: null, verifiedBy: null, lastEditedAt: null, lastEditedBy: null });
const parentRow = (id: number, name: string): MigrationFeatureRow => feature(id, name, null, "manual");

const candidateDoc = JSON.stringify([
  { name: "客户沟通", summary: "沟通来源", featureIds: [71, 15118], evidencePaths: ["app/a.ts"], unknowns: [], source: "generated" },
  { name: "运维保障", summary: "技术运维", featureIds: [305] },
]);

describe("parseDomainsDocument (通用化)", () => {
  it("accepts the candidate-review JSON shape and derives unique keys from names", () => {
    const result = parseDomainsDocument(candidateDoc);
    expect(result.errors).toEqual([]);
    expect(result.domains).toEqual([
      { key: "客户沟通", name: "客户沟通", summary: "沟通来源", featureIds: [71, 15118] },
      { key: "运维保障", name: "运维保障", summary: "技术运维", featureIds: [305] },
    ]);
    expect(result.ungroupedIds).toEqual([]);
  });

  it("accepts { domains, ungroupedIds } object form", () => {
    const result = parseDomainsDocument(JSON.stringify({ domains: [{ name: "域A", featureIds: [1] }], ungroupedIds: [9] }));
    expect(result.errors).toEqual([]);
    expect(result.domains[0].key).toBe("域A");
    expect(result.ungroupedIds).toEqual([9]);
  });

  it("rejects empty documents, empty domains, duplicate names and non-numeric ids; tolerates string ids", () => {
    expect(parseDomainsDocument("[]").errors.length).toBeGreaterThan(0);
    expect(parseDomainsDocument("not json").errors.length).toBeGreaterThan(0);
    expect(parseDomainsDocument(JSON.stringify([{ name: "空域", featureIds: [] }])).errors.length).toBeGreaterThan(0);
    expect(parseDomainsDocument(JSON.stringify([{ name: "A", featureIds: [1] }, { name: "A", featureIds: [2] }])).errors.length).toBeGreaterThan(0);
    expect(parseDomainsDocument(JSON.stringify([{ name: "A", featureIds: ["abc"] }])).errors.length).toBeGreaterThan(0);
    // 数字字符串 ID 容错（与候选解析同口径）
    const tolerated = parseDomainsDocument(JSON.stringify([{ name: "A", featureIds: ["71", 72] }]));
    expect(tolerated.errors).toEqual([]);
    expect(tolerated.domains[0].featureIds).toEqual([71, 72]);
  });
});

const genericFeatures = (): MigrationFeatureRow[] => [feature(71, "多源沟通录入与录音"), feature(15118, "Agent 邮箱与微信记录入库"), feature(305, "Web 管理后台"), feature(78, "数据安全与合规")];

function fakeConnection(features: MigrationFeatureRow[], failOn?: string) {
  let insertCounter = 5000;
  const statements: Array<{ statement: string; parameters?: unknown[] }> = [];
  const lifecycle: string[] = [];
  const connection: MigrationConnection & { statements: typeof statements; lifecycle: typeof lifecycle } = {
    statements,
    lifecycle,
    async execute(statement: string, parameters?: unknown[]) {
      statements.push({ statement, parameters });
      if (statement.startsWith("SELECT id, slug FROM products")) return [[{ id: 9, slug: "other" }], []];
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

describe("planBusinessDomainMigration incremental mode (通用化)", () => {
  const domains = [
    { key: "communication", name: "客户沟通", summary: "", featureIds: [71, 15118] },
    { key: "ops", name: "运维保障", summary: "", featureIds: [305] },
  ];

  it("keeps strict semantics by default: a grouped child aborts the plan", () => {
    const features = [...genericFeatures(), parentRow(500, "客户沟通"), feature(71, "多源沟通录入与录音", 500)];
    const plan = planBusinessDomainMigration(features, domains);
    expect(plan.errors.join("")).toContain("已有父级");
    expect(plan.moves).toHaveLength(0);
  });

  it("incremental: a child already under the target domain parent is kept, not moved", () => {
    const features = [...genericFeatures(), parentRow(500, "客户沟通"), feature(71, "多源沟通录入与录音", 500)];
    const plan = planBusinessDomainMigration(features, domains, { incremental: true });
    expect(plan.errors).toEqual([]);
    expect(plan.kept.map((item) => item.featureId)).toEqual([71]);
    expect(plan.moves.map((move) => move.featureId)).toEqual([15118, 305]);
  });

  it("incremental: a child under a different domain aborts with a conflict", () => {
    const features = [...genericFeatures(), parentRow(600, "别的域"), feature(71, "多源沟通录入与录音", 600)];
    const plan = planBusinessDomainMigration(features, domains, { incremental: true });
    expect(plan.errors.join("")).toContain("冲突");
    expect(plan.moves).toHaveLength(0);
  });
});

describe("runBusinessDomainMigration with provided domains (通用化)", () => {
  const domains = [
    { key: "communication", name: "客户沟通", summary: "沟通来源", featureIds: [71, 15118] },
    { key: "ops", name: "运维保障", summary: "技术运维", featureIds: [305, 78] },
  ];

  it("applies the provided domain mapping, not the salesbuddy list, with idempotent parent inserts", async () => {
    const connection = fakeConnection(genericFeatures());
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "generic-domain-"));
    const result = await runBusinessDomainMigration({ productSlug: "other", domains, apply: true, backupDir, connection });
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(connection.lifecycle).toEqual(["begin", "commit", "release"]);
    const inserts = connection.statements.filter((entry) => entry.statement.startsWith("INSERT INTO features"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].statement).toContain("ON DUPLICATE KEY UPDATE");
    const updates = connection.statements.filter((entry) => entry.statement.startsWith("UPDATE features"));
    expect(updates).toHaveLength(4);
    const backup = JSON.parse(fs.readFileSync(path.join(backupDir, fs.readdirSync(backupDir)[0]), "utf8"));
    expect(backup.children).toHaveLength(4);
    expect(backup.domains.map((domain: { name: string }) => domain.name)).toEqual(["客户沟通", "运维保障"]);
  });

  it("refuses to run without a domain mapping", async () => {
    const connection = fakeConnection(genericFeatures());
    const result = await runBusinessDomainMigration({ productSlug: "other", connection });
    expect(result.ok).toBe(false);
    expect(result.errors.join("")).toContain("domains");
    expect(connection.lifecycle).not.toContain("begin");
    expect(connection.lifecycle).not.toContain("commit");
  });

  it("incremental apply re-activates existing parents and only updates actually-moved children", async () => {
    // 第二轮：71/305/78 已在各域父节点下，仅 15118 是新增待归属
    const features = [
      ...genericFeatures().map((row) => (row.id === 305 ? { ...row, parentId: 5002 } : row.id === 78 ? { ...row, parentId: 5002 } : row.id === 71 ? { ...row, parentId: 5001 } : row)),
      parentRow(5001, "客户沟通"),
      parentRow(5002, "运维保障"),
    ];
    const connection = fakeConnection(features);
    const result = await runBusinessDomainMigration({ productSlug: "other", domains, incremental: true, apply: true, connection });
    expect(result.ok).toBe(true);
    expect(result.plan.kept.map((item) => item.featureId)).toEqual([71, 305, 78]);
    const updates = connection.statements.filter((entry) => entry.statement.startsWith("UPDATE features"));
    expect(updates.map((entry) => entry.parameters?.[1])).toEqual([15118]);
    expect(connection.statements.some((entry) => JSON.stringify(entry.parameters) === JSON.stringify([null, 71]))).toBe(false);
  });
});
