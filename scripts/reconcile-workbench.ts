/**
 * 一次性对账（I1 P0，docs/m9-workbench-carry-forward-handoff.md #2）：
 * 以每个产品仓库最新 spec_versions 的 spec_features/spec_scenarios 回填
 * features/scenarios 的 active 状态，恢复被「AI 原始输出下线基准」错误下线的
 * generated 功能。幂等：重复执行只影响仍处于 inactive 的行，并输出两层等价检测。
 * 用法：npx tsx scripts/reconcile-workbench.ts
 */
import { getDb } from "../lib/db";

interface ReconcileReport {
  slug: string;
  versionId: number | null;
  reactivatedFeatures: number;
  reactivatedScenarios: number;
  versionFeatures: number;
  workbenchFeatures: number;
  invisibleCount: number;
}

async function reconcileProduct(db: ReturnType<typeof getDb>, slug: string): Promise<ReconcileReport[]> {
  const reports: ReconcileReport[] = [];
  const [products] = await db.execute("SELECT id FROM products WHERE slug = ?", [slug]);
  const product = (products as Array<{ id: number }>)[0];
  if (!product) throw new Error(`product not found: ${slug}`);
  const [repos] = await db.execute("SELECT id FROM repositories WHERE product_id = ?", [product.id]);
  for (const repo of repos as Array<{ id: number }>) {
    const [versions] = await db.execute("SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1", [repo.id]);
    const version = (versions as Array<{ id: number }>)[0];
    if (!version) continue;
    const [featureResult] = await db.execute(
      `UPDATE features f
       JOIN spec_features sf ON sf.spec_version_id = ? AND sf.name = f.name
       SET f.active = 1
       WHERE f.product_id = ? AND f.source = 'generated' AND f.active = 0`,
      [version.id, product.id],
    );
    const [scenarioResult] = await db.execute(
      `UPDATE scenarios s
       JOIN features f ON f.id = s.feature_id
       JOIN spec_features sf ON sf.spec_version_id = ? AND sf.name = f.name
       JOIN spec_scenarios ss ON ss.spec_feature_id = sf.id AND ss.reference = s.reference
       SET s.active = 1
       WHERE f.product_id = ? AND s.source = 'generated' AND s.active = 0`,
      [version.id, product.id],
    );
    const [counts] = await db.execute(
      `SELECT
         (SELECT COUNT(*) FROM spec_features WHERE spec_version_id = ?) AS versionFeatures,
         (SELECT COUNT(*) FROM features WHERE product_id = ? AND active = 1) AS workbenchFeatures,
         (SELECT COUNT(*) FROM spec_features sf
          LEFT JOIN features f ON f.product_id = ? AND f.name = sf.name AND f.active = 1
          WHERE sf.spec_version_id = ? AND f.id IS NULL) AS invisibleCount`,
      [version.id, product.id, product.id, version.id],
    );
    const row = (counts as Array<{ versionFeatures: number; workbenchFeatures: number; invisibleCount: number }>)[0];
    reports.push({
      slug,
      versionId: version.id,
      reactivatedFeatures: (featureResult as { affectedRows?: number }).affectedRows ?? 0,
      reactivatedScenarios: (scenarioResult as { affectedRows?: number }).affectedRows ?? 0,
      versionFeatures: Number(row.versionFeatures),
      workbenchFeatures: Number(row.workbenchFeatures),
      invisibleCount: Number(row.invisibleCount),
    });
  }
  return reports;
}

export async function reconcileWorkbench(slug?: string) {
  const db = getDb();
  try {
    if (slug) return await reconcileProduct(db, slug);
    const [products] = await db.execute("SELECT slug FROM products ORDER BY slug");
    const all: ReconcileReport[] = [];
    for (const row of products as Array<{ slug: string }>) all.push(...await reconcileProduct(db, row.slug));
    return all;
  } finally {
    await db.end();
  }
}

if (process.argv[1]?.endsWith("reconcile-workbench.ts")) {
  const slug = process.argv[2];
  reconcileWorkbench(slug)
    .then((reports) => {
      for (const report of reports) console.log(JSON.stringify(report));
      const broken = reports.filter((report) => report.invisibleCount > 0);
      if (broken.length > 0) {
        console.error(`reconcile incomplete: ${broken.map((report) => report.slug).join(",")} still have invisible features`);
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
