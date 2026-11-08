import type { PoolConnection } from "mysql2/promise";
import { getDb, defaultExecute, type Execute } from "./db";

/**
 * P1 规格核实（docs/spec-verification-lifecycle-design.md）：
 * 核实 = 人工确认「规格条目当前内容 × 指定代码版本」一致，双版本绑定入历史表（append-only）；
 * 工作表 verified_at 置位并清除漂移标记（核实是唯一能清 stale 的人工动作）。
 * 状态为推导值：未核实 = verified_at NULL；已核实 = verified_at 非空且 stale_since 空；
 * 待重新核实 = verified_at 与 stale_since 均非空。
 */

export type SpecEntityType = "feature" | "scenario";

export interface VerificationSpec {
  specVersionId: number;
  sha: string;
}

/** 在事务内执行核实：范围校验的 UPDATE（同时清 stale）+ 历史记录 INSERT。 */
export async function applyVerification(
  connection: Pick<PoolConnection, "execute">,
  input: { productId: number; entityType: SpecEntityType; entityId: number; verifiedBy: string },
  spec: VerificationSpec,
) {
  const update = input.entityType === "feature"
    ? {
        sql: "UPDATE features SET verified_at = CURRENT_TIMESTAMP(3), verified_by = ?, stale_since = NULL, stale_change_id = NULL WHERE id = ? AND product_id = ? AND active = 1",
        params: [input.verifiedBy, input.entityId, input.productId],
      }
    : {
        sql: "UPDATE scenarios s JOIN features f ON f.id = s.feature_id SET s.verified_at = CURRENT_TIMESTAMP(3), s.verified_by = ?, s.stale_since = NULL, s.stale_change_id = NULL WHERE s.id = ? AND f.product_id = ? AND s.active = 1",
        params: [input.verifiedBy, input.entityId, input.productId],
      };
  const [result] = await connection.execute(update.sql, update.params) as [{ affectedRows?: number }, unknown];
  if (!result.affectedRows) throw new Error("spec_entity_invalid");
  await connection.execute(
    `INSERT INTO spec_verifications (product_id, entity_type, entity_id, spec_version_id, commit_sha, verified_by, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
    [input.productId, input.entityType, input.entityId, spec.specVersionId, spec.sha, input.verifiedBy],
  );
}

/** 解析产品最新规格快照：核实绑定其 spec_version 与对应 commit。 */
export async function loadLatestVerificationSpec(productId: number, execute: Execute = defaultExecute): Promise<VerificationSpec | null> {
  const [rows] = await execute(
    `SELECT v.id AS specVersionId, v.sha FROM spec_versions v
     JOIN repositories r ON r.id = v.repository_id
     WHERE r.product_id = ? ORDER BY v.id DESC LIMIT 1`,
    [productId],
  ) as [Array<{ specVersionId: number; sha: string }>, unknown];
  const row = (rows as Array<{ specVersionId: number; sha: string }>)[0];
  return row ? { specVersionId: Number(row.specVersionId), sha: row.sha } : null;
}

export async function verifySpecEntity(input: { productId: number; entityType: SpecEntityType; entityId: number; verifiedBy: string }) {
  const db = getDb();
  const spec = await loadLatestVerificationSpec(input.productId);
  if (!spec) throw new Error("spec_version_missing");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await applyVerification(connection, input, spec);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
