import "dotenv/config";
import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { parseJsonValue } from "../lib/json";
import { buildReleaseChangeProjections, type ReleaseChangeFact, type ReleaseChangeProjection } from "../lib/release-change-projection";

export interface LegacyChangeRow {
  id: number;
  releaseId: number;
  featureName: string;
  kind: string;
  description: string;
  userImpact: string;
  evidence: unknown;
}

export interface LegacySourceRow {
  changeId: number;
  specChangeId: number;
}

export interface RebuildReleaseInput {
  releaseId: number;
  facts: ReleaseChangeFact[];
  existingChanges: LegacyChangeRow[];
  existingSources: LegacySourceRow[];
}

export interface ProjectionBackup {
  id: number;
  releaseId: number;
  changes: LegacyChangeRow[];
  sources: LegacySourceRow[];
}

export interface ReleaseRebuildPlan {
  releaseId: number;
  projections: ReleaseChangeProjection[];
  backup: Omit<ProjectionBackup, "id">;
}

export function planReleaseRebuild(input: RebuildReleaseInput): ReleaseRebuildPlan | null {
  if (input.facts.length === 0 || input.existingSources.length > 0) return null;
  return {
    releaseId: input.releaseId,
    projections: buildReleaseChangeProjections(input.facts),
    backup: { releaseId: input.releaseId, changes: input.existingChanges, sources: input.existingSources },
  };
}

export async function applyReleaseRebuild(connection: PoolConnection, input: RebuildReleaseInput): Promise<{ backupId: number; projectionCount: number } | null> {
  await connection.beginTransaction();
  try {
    await connection.execute("SELECT id FROM releases WHERE id = ? FOR UPDATE", [input.releaseId]);
    const plan = planReleaseRebuild(input);
    if (!plan) {
      await connection.commit();
      return null;
    }
    const [backupResult] = await connection.execute(
      "INSERT INTO release_change_projection_backups (release_id, changes_json, sources_json) VALUES (?, ?, ?)",
      [input.releaseId, JSON.stringify(input.existingChanges), JSON.stringify(input.existingSources)],
    );
    const backupId = Number((backupResult as { insertId: number }).insertId);
    await connection.execute("DELETE FROM changes WHERE release_id = ?", [input.releaseId]);
    for (const projection of plan.projections) {
      const [changeResult] = await connection.execute(
        "INSERT INTO changes (release_id, feature_name, kind, description, user_impact, evidence) VALUES (?, ?, ?, ?, ?, ?)",
        [input.releaseId, projection.featureName, projection.kind, projection.description, projection.userImpact, JSON.stringify(projection.evidence)],
      );
      const changeId = Number((changeResult as { insertId: number }).insertId);
      for (const specChangeId of projection.sourceSpecChangeIds) {
        await connection.execute("INSERT INTO change_sources (change_id, spec_change_id) VALUES (?, ?)", [changeId, specChangeId]);
      }
    }
    await connection.commit();
    return { backupId, projectionCount: plan.projections.length };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export async function restoreProjectionBackup(connection: PoolConnection, backup: ProjectionBackup): Promise<void> {
  await connection.beginTransaction();
  try {
    await connection.execute("SELECT id FROM releases WHERE id = ? FOR UPDATE", [backup.releaseId]);
    await connection.execute("DELETE FROM changes WHERE release_id = ?", [backup.releaseId]);
    for (const change of backup.changes) {
      await connection.execute(
        "INSERT INTO changes (id, release_id, feature_name, kind, description, user_impact, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [change.id, change.releaseId, change.featureName, change.kind, change.description, change.userImpact, JSON.stringify(change.evidence)],
      );
    }
    for (const source of backup.sources) {
      await connection.execute("INSERT INTO change_sources (change_id, spec_change_id) VALUES (?, ?)", [source.changeId, source.specChangeId]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

function parseArgs(argv: string[]) {
  const args = { repository: "", release: null as number | null, apply: false, restore: null as number | null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--repository") args.repository = argv[index + 1] ?? "";
    if (argv[index] === "--release") args.release = Number(argv[index + 1]);
    if (argv[index] === "--apply") args.apply = true;
    if (argv[index] === "--restore") args.restore = Number(argv[index + 1]);
  }
  if (!args.restore && !args.repository) throw new Error("用法：npx tsx scripts/rebuild-release-change-projections.ts --repository <slug|id> [--release <id>] [--apply]，或 --restore <backupId>");
  return args;
}

async function resolveRepository(db: Pool, repository: string): Promise<number> {
  const column = /^\d+$/.test(repository) ? "id" : "name";
  const [rows] = await db.execute(`SELECT id FROM repositories WHERE ${column} = ? LIMIT 1`, [repository]);
  const id = Number((rows as Array<{ id: number }>)[0]?.id ?? 0);
  if (!id) throw new Error(`仓库不存在：${repository}`);
  return id;
}

async function loadReleaseInputs(db: Pool, repositoryId: number, releaseId: number | null): Promise<RebuildReleaseInput[]> {
  const [releases] = await db.execute(
    `SELECT id FROM releases WHERE repository_id = ? AND spec_version_id IS NOT NULL ${releaseId ? "AND id = ?" : ""} ORDER BY id`,
    releaseId ? [repositoryId, releaseId] : [repositoryId],
  );
  const inputs: RebuildReleaseInput[] = [];
  for (const release of releases as Array<{ id: number }>) {
    const [factRows] = await db.execute(
      `SELECT id, entity_type AS entityType, kind, feature_name AS featureName, scenario_reference AS scenarioReference,
              summary, before_json AS beforeJson, after_json AS afterJson
       FROM spec_changes WHERE spec_version_id = (SELECT spec_version_id FROM releases WHERE id = ?) ORDER BY id`,
      [release.id],
    );
    const facts = (factRows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      entityType: row.entityType,
      kind: row.kind,
      featureName: row.featureName,
      scenarioReference: row.scenarioReference === "" ? null : row.scenarioReference,
      summary: row.summary,
      before: parseJsonValue(row.beforeJson),
      after: parseJsonValue(row.afterJson),
    })) as ReleaseChangeFact[];
    const [changeRows] = await db.execute(
      "SELECT id, release_id AS releaseId, feature_name AS featureName, kind, description, user_impact AS userImpact, evidence FROM changes WHERE release_id = ? ORDER BY id",
      [release.id],
    );
    const existingChanges = (changeRows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      releaseId: Number(row.releaseId),
      featureName: String(row.featureName),
      kind: String(row.kind),
      description: String(row.description),
      userImpact: String(row.userImpact),
      evidence: parseJsonValue(row.evidence),
    }));
    const [sourceRows] = await db.execute(
      `SELECT s.change_id AS changeId, s.spec_change_id AS specChangeId
       FROM change_sources s JOIN changes c ON c.id = s.change_id WHERE c.release_id = ? ORDER BY s.change_id, s.spec_change_id`,
      [release.id],
    );
    inputs.push({ releaseId: release.id, facts, existingChanges, existingSources: sourceRows as LegacySourceRow[] });
  }
  return inputs;
}

async function restoreById(db: Pool, backupId: number) {
  const [rows] = await db.execute("SELECT id, release_id AS releaseId, changes_json AS changesJson, sources_json AS sourcesJson FROM release_change_projection_backups WHERE id = ?", [backupId]);
  const row = (rows as Array<{ id: number; releaseId: number; changesJson: unknown; sourcesJson: unknown }>)[0];
  if (!row) throw new Error(`备份不存在：${backupId}`);
  const backup: ProjectionBackup = {
    id: row.id,
    releaseId: row.releaseId,
    changes: parseJsonValue(row.changesJson) as LegacyChangeRow[],
    sources: parseJsonValue(row.sourcesJson) as LegacySourceRow[],
  };
  const connection = await db.getConnection();
  try {
    await restoreProjectionBackup(connection, backup);
    console.log(`已用备份 #${backupId} 恢复 release #${backup.releaseId}：${backup.changes.length} 条 changes、${backup.sources.length} 条来源关联。`);
  } finally {
    connection.release();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = mysql.createPool(databaseConfig(true));
  try {
    if (args.restore) {
      await restoreById(db, args.restore);
      return;
    }
    const repositoryId = await resolveRepository(db, args.repository);
    const inputs = await loadReleaseInputs(db, repositoryId, args.release);
    const plans = inputs.map((input) => ({ input, plan: planReleaseRebuild(input) }));
    const candidates = plans.filter((item) => item.plan !== null);
    for (const { input, plan } of plans) {
      if (!plan) {
        console.log(`[release #${input.releaseId}] 跳过（${input.facts.length === 0 ? "无规范事实" : "已是来源关联投影"}）`);
        continue;
      }
      console.log(`[release #${input.releaseId}] ${input.existingChanges.length} → ${plan.projections.length} 条 changes；来源关联 ${plan.projections.reduce((total, projection) => total + projection.sourceSpecChangeIds.length, 0)} 条`);
    }
    if (!args.apply) {
      console.log(`dry-run：${candidates.length} 个 release 可重建；未改动数据。核对方案后加 --apply。`);
      return;
    }
    for (const { input } of candidates) {
      const connection = await db.getConnection();
      try {
        const result = await applyReleaseRebuild(connection, input);
        if (result) console.log(`[release #${input.releaseId}] 已重建 ${result.projectionCount} 条；备份 #${result.backupId}（可用 --restore ${result.backupId} 恢复）`);
      } finally {
        connection.release();
      }
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1]?.endsWith("rebuild-release-change-projections.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
