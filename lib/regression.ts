import { defaultExecute, type Execute } from "./db";
import { regressionStatusKey, type RegressionStatus, type RegressionStatusMap } from "./regression-view";

export { regressionStatusLabels, regressionStatusKey, renderRegressionMarkdown, type RegressionItemView, type RegressionStatus, type RegressionStatusMap } from "./regression-view";

export async function loadRegressionStatuses(productId: number, execute: Execute = defaultExecute): Promise<RegressionStatusMap> {
  const [rows] = await execute(
    `SELECT ri.release_id AS releaseId, ri.spec_change_id AS specChangeId, ri.status, ri.checked_by AS checkedBy
     FROM regression_items ri JOIN releases r ON r.id = ri.release_id
     WHERE r.product_id = ?`,
    [productId],
  ) as [Array<{ releaseId: number; specChangeId: number; status: RegressionStatus; checkedBy: string | null }>, unknown];
  const statuses: RegressionStatusMap = {};
  for (const row of rows) statuses[regressionStatusKey(Number(row.releaseId), Number(row.specChangeId))] = { status: row.status, checkedBy: row.checkedBy };
  return statuses;
}

export interface RegressionItemInput {
  productId: number;
  releaseId: number;
  specChangeId: number;
  status: RegressionStatus;
  checkedBy: string | null;
}

/** upsert 一条勾选状态；WHERE 先验证 release 属于该产品且 spec_change 属于该 release 的 spec 版本。 */
export async function setRegressionItem(input: RegressionItemInput, execute: Execute = defaultExecute) {
  const [result] = await execute(
    `INSERT INTO regression_items (release_id, spec_change_id, status, checked_by, checked_at)
     SELECT r.id, c.id, ?, ?, CURRENT_TIMESTAMP(3)
     FROM releases r JOIN spec_changes c ON c.id = ? AND c.spec_version_id = r.spec_version_id
     WHERE r.id = ? AND r.product_id = ?
     ON DUPLICATE KEY UPDATE status = VALUES(status), checked_by = VALUES(checked_by), checked_at = CURRENT_TIMESTAMP(3)`,
    [input.status, input.checkedBy, input.specChangeId, input.releaseId, input.productId],
  ) as [{ affectedRows?: number }, unknown];
  if (!result.affectedRows) throw new Error("regression_item_invalid");
}

