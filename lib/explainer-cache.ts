import { getDb } from "./db";

/**
 * Explainer 渲染缓存（契约 M1-T5/§10.4）：按 product + 当前 spec 版本复用，命中零 Chromium 调用。
 * 读写均 best-effort——缓存故障不阻断导出（退化为直接渲染）。
 */

async function latestSpecVersionId(productId: number): Promise<number | null> {
  const [rows] = await getDb().execute(
    `SELECT id FROM spec_versions WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
    [productId],
  );
  const row = (rows as Array<{ id: number }>)[0];
  return row ? Number(row.id) : null;
}

export async function loadCachedExplainerHtml(productId: number): Promise<string | null> {
  try {
    const versionId = await latestSpecVersionId(productId);
    if (versionId === null) return null;
    const [rows] = await getDb().execute(
      `SELECT html FROM explainer_cache WHERE product_id = ? AND spec_version_id = ?`,
      [productId, versionId],
    );
    const row = (rows as Array<{ html: string }>)[0];
    return row?.html ?? null;
  } catch (error) {
    console.warn("[billing] explainer cache read failed; rendering directly", error);
    return null;
  }
}

/** 渲染成功后写入缓存（ODKU 幂等；best-effort，失败仅告警）。 */
export async function saveExplainerCache(productId: number, html: string): Promise<void> {
  try {
    const versionId = await latestSpecVersionId(productId);
    if (versionId === null) return;
    await getDb().execute(
      `INSERT INTO explainer_cache (product_id, spec_version_id, html) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE html = VALUES(html), created_at = CURRENT_TIMESTAMP(3)`,
      [productId, versionId, html],
    );
  } catch (error) {
    console.warn("[billing] explainer cache write failed", error);
  }
}
