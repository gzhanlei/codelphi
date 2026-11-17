import "dotenv/config";
import mysql from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { generateDomainCandidates } from "../lib/business-domain-candidates";

/**
 * CLI 侧业务域候选生成（只读，不写库）：与设置页审核面板同一 AI 入口，
 * 供 agent/管理员在服务器侧产出候选 JSON 供人工审核。
 * 用法：npx tsx scripts/generate-domain-candidates.ts <productSlug>
 * 输出：{ product, featureCount, candidates, error }，candidates 已按功能名富化便于审阅。
 */

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("用法：npx tsx scripts/generate-domain-candidates.ts <productSlug>");
    process.exit(1);
  }
  const conn = await mysql.createConnection(databaseConfig());
  try {
    const [products] = await conn.query("SELECT id, name, description FROM products WHERE slug = ?", [slug]) as unknown as [Array<{ id: number; name: string; description: string | null }>, unknown];
    const product = products[0];
    if (!product) throw new Error(`产品不存在：${slug}`);
    const [features] = await conn.query("SELECT id, name, summary, parent_id AS parentId FROM features WHERE product_id = ? AND active = 1 ORDER BY name", [product.id]) as unknown as [Array<{ id: number; name: string; summary: string; parentId: number | null }>, unknown];
    if (features.length === 0) {
      console.log(JSON.stringify({ product: slug, featureCount: 0, candidates: [], error: null, note: "该产品暂无 active 功能，先跑一次分析" }, null, 2));
      return;
    }
    const placeholders = features.map(() => "?").join(", ");
    const [scenarios] = await conn.query(
      `SELECT id, feature_id AS featureId, reference, context, action, outcome, evidence FROM scenarios WHERE active = 1 AND feature_id IN (${placeholders})`,
      features.map((feature) => feature.id),
    ) as unknown as [Array<{ featureId: number; context: string; action: string; outcome: string; evidence: unknown }>, unknown];
    const result = await generateDomainCandidates({ name: product.name, description: product.description ?? "", features, scenarios });
    const nameById = new Map(features.map((feature) => [feature.id, feature.name]));
    console.log(JSON.stringify({
      product: slug,
      featureCount: features.length,
      scenarioCount: scenarios.length,
      error: result.error,
      candidates: result.candidates.map((candidate) => ({
        ...candidate,
        featureNames: candidate.featureIds.map((id) => `${id}:${nameById.get(id) ?? "?"}`),
      })),
    }, null, 2));
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
