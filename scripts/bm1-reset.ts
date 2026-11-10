import "dotenv/config";
import { getDb } from "../lib/db";
import { rebuildSpecFileIndex } from "../lib/spec-file-index";

// BM-1 版本重置（临时）：删除基线之后的最新版本 + 重建索引到 v48，使 run #2 与 run #1 同基线
const REPO_ID = 5;
const BASELINE_VERSION_ID = 48;
const AFTER_SHA = "a131fcb623d88ed9eb7e7a414e226437423d645c";

async function main() {
  const db = getDb();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [latestRows] = await conn.execute(
      "SELECT id, analysis_run_id AS runId FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1",
      [REPO_ID],
    );
    const latest = (latestRows as Array<{ id: number; runId: number }>)[0];
    if (!latest || latest.id <= BASELINE_VERSION_ID) throw new Error("nothing to reset");
    await conn.execute("DELETE FROM spec_versions WHERE id = ?", [latest.id]);
    // 该 run 生成的发布（绑定同 sha）一并删除，恢复运行前状态
    const [rels] = await conn.execute(
      "SELECT id FROM releases WHERE repository_id = ? AND sha = ?",
      [REPO_ID, AFTER_SHA],
    );
    for (const r of rels as Array<{ id: number }>) {
      await conn.execute("DELETE FROM releases WHERE id = ?", [r.id]);
    }
    await rebuildSpecFileIndex(conn, REPO_ID, BASELINE_VERSION_ID);
    await conn.commit();
    console.log(`reset: deleted spec_version ${latest.id} (run ${latest.runId}) + ${Array.isArray(rels) ? rels.length : 0} release(s) @${AFTER_SHA.slice(0, 7)}; index rebuilt on v${BASELINE_VERSION_ID}`);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
