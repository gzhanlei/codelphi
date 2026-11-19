import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DETECTOR_REGISTRY_VERSION, INVENTORY_SCHEMA_VERSION } from "../lib/behavior-inventory/index";
import { canonicalManifest, manifestHash, normalizeManifest } from "../lib/behavior-inventory/manifest";
import type { BehaviorManifest } from "../lib/behavior-inventory/types";
import {
  insertManifestIfAbsent,
  InventoryPersistenceError,
  loadVerifiedManifest,
} from "../lib/behavior-unit-receipts";
import type { Execute } from "../lib/db";

/** Task 5 契约（2026-11-19 行为清单全量分析）：run 级 manifest insert-only 持久化。
 *  同 run 同 hash 重入幂等；同 run 不同 manifest 抛 inventory_version_conflict，
 *  绝不 UPDATE/REPLACE；恢复时重算 hash，篡改 JSON 或版本不一致必须失败。
 *  inventory_generated_at 是数据库元数据（DB 默认时间戳），不进入确定性 manifest hash。 */

interface ManifestRow {
  run_id: number;
  after_sha: string;
  scope_fingerprint: string;
  inventory_schema_version: string;
  detector_registry_version: string;
  manifest_json: string;
  manifest_hash: string;
}

function baseManifest(): BehaviorManifest {
  return {
    inventorySchemaVersion: INVENTORY_SCHEMA_VERSION,
    detectorRegistryVersion: DETECTOR_REGISTRY_VERSION,
    afterSha: "c0e1d0235f033005238dc07a6bcae8a02ed171f8",
    scopeFingerprint: "a".repeat(64),
    units: [
      {
        unitKey: 'unit|http|["GET","/api/orders","src/orders.ts","listOrders"]',
        kind: "http",
        primaryPath: "src/orders.ts",
        primaryRanges: [
          { startLine: 90, endLine: 120 },
          { startLine: 1, endLine: 80 },
        ],
        contextRanges: [{ path: "src/db.ts", startLine: 5, endLine: 9 }],
        anchors: [
          {
            anchorKey: "anchor-b",
            role: "implicit_review",
            ranges: [
              { startLine: 40, endLine: 80 },
              { startLine: 20, endLine: 30 },
            ],
            evidence: [{ path: "src/orders.ts", startLine: 40 }],
            coarse: true,
          },
          {
            anchorKey: "anchor-a",
            role: "behavior",
            ranges: [{ startLine: 1, endLine: 39 }],
            evidence: [
              { path: "src/orders.ts", startLine: 3 },
              { path: "src/orders.ts", startLine: 1 },
            ],
            coarse: false,
          },
        ],
        detector: "next",
        detectorVersion: "1",
      },
    ],
    tasks: [
      {
        taskKey: "task-2",
        unitKey: 'unit|http|["GET","/api/orders","src/orders.ts","listOrders"]',
        anchorFragments: [
          { anchorKey: "anchor-a", anchorFragmentKey: "fragment-a2", ranges: [{ startLine: 10, endLine: 39 }] },
          { anchorKey: "anchor-a", anchorFragmentKey: "fragment-a1", ranges: [{ startLine: 1, endLine: 9 }] },
        ],
      },
      {
        taskKey: "task-1",
        unitKey: 'unit|http|["GET","/api/orders","src/orders.ts","listOrders"]',
        anchorFragments: [
          { anchorKey: "anchor-b", anchorFragmentKey: "fragment-b1", ranges: [{ startLine: 20, endLine: 80 }] },
        ],
      },
    ],
  };
}

/** analysis_behavior_manifests 的内存假表：INSERT 模拟 run_id 唯一键冲突（ER_DUP_ENTRY），
 *  SELECT 按 run_id 过滤；其余 SQL 一律 unrouted 报错，防止实现偷偷发出 UPDATE/REPLACE。 */
function manifestTable() {
  const rows: ManifestRow[] = [];
  const execute = vi.fn(async (statement: string, parameters: Array<string | number | null>) => {
    if (statement.startsWith("INSERT INTO analysis_behavior_manifests")) {
      const [runId, afterSha, scopeFingerprint, schemaVersion, registryVersion, manifestJson, hash] = parameters;
      if (rows.some((row) => row.run_id === runId)) {
        const error = new Error(`Duplicate entry '${runId}' for key 'analysis_behavior_manifests_run_unique'`) as Error & {
          code?: string;
          errno?: number;
        };
        error.code = "ER_DUP_ENTRY";
        error.errno = 1062;
        throw error;
      }
      rows.push({
        run_id: Number(runId),
        after_sha: String(afterSha),
        scope_fingerprint: String(scopeFingerprint),
        inventory_schema_version: String(schemaVersion),
        detector_registry_version: String(registryVersion),
        manifest_json: String(manifestJson),
        manifest_hash: String(hash),
      });
      return [{ affectedRows: 1 }];
    }
    if (statement.startsWith("SELECT manifest_json, manifest_hash FROM analysis_behavior_manifests WHERE run_id = ?")) {
      return [
        rows
          .filter((row) => row.run_id === Number(parameters[0]))
          .map((row) => ({ manifest_json: row.manifest_json, manifest_hash: row.manifest_hash })),
      ];
    }
    throw new Error(`unrouted sql: ${statement}`);
  });
  const statements = () => execute.mock.calls.map(([statement]) => String(statement));
  return { execute: execute as unknown as Execute, rows, statements };
}

function persistedRow(runId: number, manifest: BehaviorManifest): ManifestRow {
  return {
    run_id: runId,
    after_sha: manifest.afterSha,
    scope_fingerprint: manifest.scopeFingerprint,
    inventory_schema_version: manifest.inventorySchemaVersion,
    detector_registry_version: manifest.detectorRegistryVersion,
    manifest_json: canonicalManifest(manifest),
    manifest_hash: manifestHash(manifest),
  };
}

function expectErrorCode(error: unknown, code: "inventory_version_conflict" | "inventory_manifest_tampered") {
  expect(error).toBeInstanceOf(InventoryPersistenceError);
  expect((error as InventoryPersistenceError).code).toBe(code);
}

describe("insertManifestIfAbsent", () => {
  it("persists the canonical manifest and its hash exactly once", async () => {
    const { execute, rows, statements } = manifestTable();
    const manifest = baseManifest();
    await insertManifestIfAbsent(execute, 42, manifest);
    expect(rows).toHaveLength(1);
    const insertSql = statements().find((statement) => statement.startsWith("INSERT"));
    expect(insertSql).toBeDefined();
    expect(rows[0]).toMatchObject({
      run_id: 42,
      after_sha: manifest.afterSha,
      scope_fingerprint: manifest.scopeFingerprint,
      inventory_schema_version: manifest.inventorySchemaVersion,
      detector_registry_version: manifest.detectorRegistryVersion,
    });
    expect(rows[0].manifest_json).toBe(canonicalManifest(manifest));
    expect(rows[0].manifest_hash).toBe(manifestHash(manifest));
  });

  it("keeps inventory_generated_at as database metadata outside the deterministic hash", async () => {
    const { execute, statements } = manifestTable();
    await insertManifestIfAbsent(execute, 42, baseManifest());
    const insertSql = statements().find((statement) => statement.startsWith("INSERT"));
    expect(insertSql).not.toContain("inventory_generated_at");
  });

  it("is idempotent when the same run re-enters with the same manifest", async () => {
    const { execute, rows, statements } = manifestTable();
    const manifest = baseManifest();
    await insertManifestIfAbsent(execute, 42, manifest);
    await expect(insertManifestIfAbsent(execute, 42, manifest)).resolves.toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(statements().filter((statement) => statement.startsWith("INSERT"))).toHaveLength(2);
  });

  it("rejects a different manifest for the same run with inventory_version_conflict and never rewrites", async () => {
    const { execute, rows, statements } = manifestTable();
    const manifest = baseManifest();
    await insertManifestIfAbsent(execute, 42, manifest);
    const conflicting: BehaviorManifest = { ...manifest, afterSha: "f".repeat(40) };
    const error = await insertManifestIfAbsent(execute, 42, conflicting).catch((caught) => caught);
    expectErrorCode(error, "inventory_version_conflict");
    expect(rows).toHaveLength(1);
    expect(rows[0].manifest_hash).toBe(manifestHash(manifest));
    expect(statements().filter((statement) => /\b(UPDATE|REPLACE|DELETE)\b/.test(statement))).toHaveLength(0);
  });

  it("treats a same-hash duplicate-key race as idempotent re-entry", async () => {
    const { execute, rows } = manifestTable();
    const manifest = baseManifest();
    await insertManifestIfAbsent(execute, 42, manifest);
    // 并发重入：唯一键冲突后 SELECT 回读到的 hash 与本次一致 → 幂等成功而非冲突。
    const identical: BehaviorManifest = normalizeManifest(manifest);
    await expect(insertManifestIfAbsent(execute, 42, identical)).resolves.toBeUndefined();
    expect(rows).toHaveLength(1);
  });
});

describe("loadVerifiedManifest", () => {
  it("round-trips a persisted manifest into canonical form", async () => {
    const { execute } = manifestTable();
    const manifest = baseManifest();
    await insertManifestIfAbsent(execute, 42, manifest);
    const loaded = await loadVerifiedManifest(execute, 42);
    expect(loaded).toEqual(normalizeManifest(manifest));
  });

  it("rejects tampered manifest_json with inventory_manifest_tampered", async () => {
    const { execute, rows } = manifestTable();
    await insertManifestIfAbsent(execute, 42, baseManifest());
    rows[0].manifest_json = rows[0].manifest_json.replace("src/orders.ts", "src/evil.ts");
    const error = await loadVerifiedManifest(execute, 42).catch((caught) => caught);
    expectErrorCode(error, "inventory_manifest_tampered");
  });

  it("rejects a rewritten manifest_hash with inventory_manifest_tampered", async () => {
    const { execute, rows } = manifestTable();
    await insertManifestIfAbsent(execute, 42, baseManifest());
    rows[0].manifest_hash = "0".repeat(64);
    const error = await loadVerifiedManifest(execute, 42).catch((caught) => caught);
    expectErrorCode(error, "inventory_manifest_tampered");
  });

  it("rejects unparsable stored JSON with inventory_manifest_tampered", async () => {
    const { execute, rows } = manifestTable();
    await insertManifestIfAbsent(execute, 42, baseManifest());
    rows[0].manifest_json = "{not-json";
    const error = await loadVerifiedManifest(execute, 42).catch((caught) => caught);
    expectErrorCode(error, "inventory_manifest_tampered");
  });

  it("rejects structurally non-normalizable stored content with inventory_manifest_tampered", async () => {
    const { execute, rows } = manifestTable();
    const malformed = baseManifest();
    malformed.units[0].anchors[0].ranges = [{ startLine: 0, endLine: 5 }];
    rows.push({
      run_id: 42,
      after_sha: malformed.afterSha,
      scope_fingerprint: malformed.scopeFingerprint,
      inventory_schema_version: malformed.inventorySchemaVersion,
      detector_registry_version: malformed.detectorRegistryVersion,
      manifest_json: JSON.stringify(malformed),
      manifest_hash: "f".repeat(64),
    });
    const error = await loadVerifiedManifest(execute, 42).catch((caught) => caught);
    expectErrorCode(error, "inventory_manifest_tampered");
  });

  it("rejects a run without any persisted manifest with inventory_manifest_tampered", async () => {
    const { execute } = manifestTable();
    const error = await loadVerifiedManifest(execute, 99).catch((caught) => caught);
    expectErrorCode(error, "inventory_manifest_tampered");
  });

  it("rejects an inventory schema version mismatch with inventory_version_conflict", async () => {
    const { execute, rows } = manifestTable();
    rows.push(persistedRow(42, { ...baseManifest(), inventorySchemaVersion: "0" }));
    const error = await loadVerifiedManifest(execute, 42).catch((caught) => caught);
    expectErrorCode(error, "inventory_version_conflict");
  });

  it("rejects a detector registry version mismatch with inventory_version_conflict", async () => {
    const { execute, rows } = manifestTable();
    rows.push(persistedRow(42, { ...baseManifest(), detectorRegistryVersion: "generic@0+next@0+residual@0" }));
    const error = await loadVerifiedManifest(execute, 42).catch((caught) => caught);
    expectErrorCode(error, "inventory_version_conflict");
  });
});

describe("migration 080 dependencies", () => {
  const sql = readFileSync(path.join(__dirname, "..", "migrations", "080_behavior_inventory.sql"), "utf8");

  it("only references existing analysis_runs and spec_scenarios tables", () => {
    const targets = [...sql.matchAll(/REFERENCES\s+(\w+)\s*\(/g)].map((match) => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set(["analysis_runs", "spec_scenarios"]));
  });

  it("never rewrites historical rows (no UPDATE/REPLACE/DELETE of existing data)", () => {
    const withoutComments = sql
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const statements = withoutComments
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement).toMatch(/^(CREATE TABLE|ALTER TABLE)/);
    }
  });

  it("declares the frozen uniqueness and index contract for long logical keys", () => {
    expect(sql).toContain("UNIQUE KEY analysis_behavior_tasks_run_task_unique (run_id, task_key_hash)");
    expect(sql).toContain("KEY analysis_behavior_tasks_run_status_idx (run_id, status)");
    expect(sql).toContain("KEY analysis_behavior_tasks_run_unit_status_idx (run_id, unit_key_hash, status)");
    expect(sql).toContain("KEY analysis_behavior_tasks_lease_idx (lease_expires_at, status)");
    expect(sql).toContain("UNIQUE KEY analysis_behavior_anchor_scenarios_link_unique (run_id, anchor_key_hash, local_scenario_key_hash)");
    expect(sql).toContain("UNIQUE KEY analysis_behavior_manifests_run_unique (run_id)");
    expect(sql).toContain("UNIQUE KEY analysis_run_budgets_run_unique (run_id)");
  });

  it("adds the nullable LLM receipt metadata columns without touching existing columns", () => {
    expect(sql).toMatch(/ALTER TABLE llm_call_receipts[\s\S]*ADD COLUMN task_key/);
    expect(sql).toMatch(/ADD COLUMN unit_key/);
    expect(sql).toMatch(/ADD COLUMN attempt_id/);
    expect(sql).toMatch(/ADD COLUMN call_stage/);
    expect(sql).not.toMatch(/MODIFY COLUMN task_key|CHANGE COLUMN task_key/);
  });
});
