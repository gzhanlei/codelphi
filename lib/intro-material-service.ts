import type { IntroMaterialDraft } from "./intro-material";
import { getDb } from "./db";
import { parseJsonValue } from "./json";

/** 介绍材料草稿持久化（migration 063）：(product, spec_version) 唯一，重生成覆盖旧稿。 */

type Execute = ReturnType<typeof getDb>["execute"];

export interface IntroMaterialRow {
  id: number;
  specVersionId: number | null;
  draft: IntroMaterialDraft;
  status: string;
  pptProjectId: string | null;
  pptJobId: string | null;
  pptStatus: string | null;
  pptError: string | null;
  updatedAt: Date | null;
}

export async function loadIntroMaterial(execute: Execute, productId: number, specVersionId: number | null): Promise<IntroMaterialRow | null> {
  const [rows] = await execute(
    `SELECT id, spec_version_id AS specVersionId, content_json AS contentJson, status,
            ppt_project_id AS pptProjectId, ppt_job_id AS pptJobId, ppt_status AS pptStatus,
            ppt_error AS pptError, updated_at AS updatedAt
     FROM intro_materials WHERE product_id = ? AND (spec_version_id = ? OR (spec_version_id IS NULL AND ? IS NULL))`,
    [productId, specVersionId, specVersionId],
  );
  const row = (rows as Array<{
    id: number; specVersionId: number | null; contentJson: unknown; status: string;
    pptProjectId: string | null; pptJobId: string | null; pptStatus: string | null; pptError: string | null; updatedAt: Date | null;
  }>)[0];
  if (!row) return null;
  const content = parseJsonValue(row.contentJson) as { slides?: unknown } | null;
  if (!content || !Array.isArray(content.slides)) return null;
  return {
    id: row.id,
    specVersionId: row.specVersionId === null ? null : Number(row.specVersionId),
    draft: content as unknown as IntroMaterialDraft,
    status: row.status,
    pptProjectId: row.pptProjectId,
    pptJobId: row.pptJobId,
    pptStatus: row.pptStatus,
    pptError: row.pptError,
    updatedAt: row.updatedAt,
  };
}

export async function saveIntroMaterial(execute: Execute, input: { productId: number; specVersionId: number | null; draft: IntroMaterialDraft; createdBySub: string }): Promise<number> {
  const [result] = await execute(
    `INSERT INTO intro_materials (product_id, spec_version_id, content_json, status, created_by)
     VALUES (?, ?, ?, 'draft', (SELECT id FROM users WHERE chandler_sub = ? LIMIT 1))
     ON DUPLICATE KEY UPDATE content_json = VALUES(content_json), status = 'draft',
       ppt_project_id = NULL, ppt_job_id = NULL, ppt_status = NULL, ppt_error = NULL`,
    [input.productId, input.specVersionId, JSON.stringify(input.draft), input.createdBySub],
  );
  // ODKU 更新分支的 insertId 不可靠，按唯一键反查兜底。
  const id = Number((result as { insertId?: number }).insertId ?? 0);
  if (id > 0) return id;
  const [rows] = await execute(
    "SELECT id FROM intro_materials WHERE product_id = ? AND (spec_version_id = ? OR (spec_version_id IS NULL AND ? IS NULL))",
    [input.productId, input.specVersionId, input.specVersionId],
  );
  return Number((rows as Array<{ id: number }>)[0]?.id ?? 0);
}

export async function updatePptFields(execute: Execute, materialId: number, fields: { pptProjectId?: string | null; pptJobId?: string | null; pptStatus?: string | null; pptError?: string | null }): Promise<void> {
  await execute(
    `UPDATE intro_materials SET
       ppt_project_id = COALESCE(?, ppt_project_id),
       ppt_job_id = COALESCE(?, ppt_job_id),
       ppt_status = ?,
       ppt_error = ?
     WHERE id = ?`,
    [
      fields.pptProjectId ?? null,
      fields.pptJobId ?? null,
      fields.pptStatus ?? null,
      fields.pptError ?? null,
      materialId,
    ],
  );
}
