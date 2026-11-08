import "dotenv/config";
import mysql from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { parseJsonValue } from "../lib/json";
import { specChangeWordingOnly } from "../lib/spec-diff";

interface ChangeRow {
  id: number;
  kind: string;
  featureKey: string;
  beforeJson: unknown;
  afterJson: unknown;
}

/**
 * P0 措辞降噪的历史回填：把「仅措辞差异」与「同功能内换编号抖动」的历史 spec_changes 行标记为 wording_only。
 * 与分析时 diffSpec 的折叠口径一致：changed 行按 before/after 行为字段等价判定；
 * removed↔added 对按同 feature_key + 行为字段逐项等价配对，两侧一并标记。
 * 幂等：可重复执行，已标记的行跳过。
 */
async function backfill() {
  const db = mysql.createPool(databaseConfig(true));
  try {
    const [versionRows] = await db.execute(
      "SELECT DISTINCT spec_version_id AS versionId FROM spec_changes WHERE wording_only = 0",
    ) as [Array<{ versionId: number }>, unknown];

    let marked = 0;
    for (const { versionId } of versionRows) {
      const [rows] = await db.execute(
        `SELECT id, kind, feature_key AS featureKey, before_json AS beforeJson, after_json AS afterJson
         FROM spec_changes
         WHERE spec_version_id = ? AND wording_only = 0
           AND (kind = 'changed' OR (kind IN ('added', 'removed') AND entity_type = 'scenario'))`,
        [versionId],
      ) as [Array<ChangeRow>, unknown];

      const ids: number[] = [];
      for (const row of rows.filter((item) => item.kind === "changed")) {
        if (specChangeWordingOnly(parseJsonValue(row.beforeJson), parseJsonValue(row.afterJson))) ids.push(Number(row.id));
      }

      // 换编号抖动配对：removed.before 与 added.after 行为字段逐项等价，且同属一个功能。
      const removed = rows.filter((row) => row.kind === "removed");
      const added = rows.filter((row) => row.kind === "added");
      const usedAdded = new Set<number>();
      for (const removedRow of removed) {
        for (const [index, addedRow] of added.entries()) {
          if (usedAdded.has(index) || addedRow.featureKey !== removedRow.featureKey) continue;
          if (!specChangeWordingOnly(parseJsonValue(removedRow.beforeJson), parseJsonValue(addedRow.afterJson))) continue;
          usedAdded.add(index);
          ids.push(Number(removedRow.id), Number(addedRow.id));
          break;
        }
      }

      if (ids.length === 0) continue;
      const placeholders = ids.map(() => "?").join(",");
      await db.execute(`UPDATE spec_changes SET wording_only = 1 WHERE id IN (${placeholders})`, ids);
      marked += ids.length;
      console.log(`spec_version ${versionId}: marked ${ids.length} rows`);
    }
    console.log(`backfill done: ${marked} rows marked wording_only across ${versionRows.length} versions`);
  } finally {
    await db.end();
  }
}

void backfill();
