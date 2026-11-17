import "dotenv/config";
import mysql from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { buildDomainMergePrompt, generateDomainCandidates, parseDomainMerge, type DomainCandidate } from "../lib/business-domain-candidates";
import { requestStructuredCompletion } from "../lib/ai";

/**
 * CLI 侧业务域候选生成（只读，不写库）：与设置页审核面板同一 AI 入口，
 * 供 agent/管理员在服务器侧产出候选 JSON 供人工审核。
 * 用法：npx tsx scripts/generate-domain-candidates.ts <productSlug> [--batch <每批功能数>]
 * 大产品（如 150+ 功能）用 --batch 50：分批生成子候选后做一次全局合成
 * （合成步 AI 只分组索引，featureIds 程序拼接，ID 不经 AI）。
 * 输出：{ product, featureCount, candidates, error }，candidates 已按功能名富化便于审阅。
 */

async function generateBatched(productName: string, description: string, features: Array<{ id: number; name: string; summary: string; parentId: number | null }>, scenarios: Array<{ featureId: number; context: string; action: string; outcome: string; evidence: unknown }>, batchSize: number): Promise<{ candidates: DomainCandidate[]; error: string | null; batches: number }> {
  const subCandidates: DomainCandidate[] = [];
  for (let start = 0; start < features.length; start += batchSize) {
    const batchFeatures = features.slice(start, start + batchSize);
    const batchIds = new Set(batchFeatures.map((feature) => feature.id));
    const batchScenarios = scenarios.filter((scenario) => batchIds.has(scenario.featureId));
    const batchResult = await generateDomainCandidates({ name: productName, description, features: batchFeatures, scenarios: batchScenarios });
    if (batchResult.error || batchResult.candidates.length === 0) {
      return { candidates: [], error: `第 ${Math.floor(start / batchSize) + 1} 批生成失败：${batchResult.error ?? "无有效候选"}`, batches: 0 };
    }
    subCandidates.push(...batchResult.candidates);
  }
  const content = await requestStructuredCompletion(buildDomainMergePrompt(productName, subCandidates));
  const merged = parseDomainMerge(content, subCandidates);
  if (merged.errors.length > 0) return { candidates: [], error: `合成失败：${merged.errors.join("；")}`, batches: Math.ceil(features.length / batchSize) };
  const validIds = new Set(features.map((feature) => feature.id));
  const candidates: DomainCandidate[] = merged.domains
    .map((domain) => {
      const featureIds = domain.featureIds.filter((id) => validIds.has(id));
      const unknowns: DomainCandidate["unknowns"] = domain.featureIds.filter((id) => !validIds.has(id));
      if (featureIds.length === 0) unknowns.push("empty");
      return { name: domain.name, summary: domain.summary, featureIds, evidencePaths: [], unknowns, source: "generated" as const };
    })
    .filter((candidate) => candidate.featureIds.length > 0 || candidate.unknowns.length > 0);
  return { candidates, error: null, batches: Math.ceil(features.length / batchSize) };
}

async function main() {
  const slug = process.argv[2];
  const batchFlag = process.argv.indexOf("--batch");
  const batchSize = batchFlag > 0 ? Number(process.argv[batchFlag + 1]) : 0;
  if (!slug || (batchFlag > 0 && (!Number.isInteger(batchSize) || batchSize < 5))) {
    console.error("用法：npx tsx scripts/generate-domain-candidates.ts <productSlug> [--batch <每批功能数≥5>]");
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
    let result: { candidates: DomainCandidate[]; error: string | null };
    let batches = 0;
    if (batchSize > 0 && features.length > batchSize) {
      const batched = await generateBatched(product.name, product.description ?? "", features, scenarios, batchSize);
      result = { candidates: batched.candidates, error: batched.error };
      batches = batched.batches;
    } else {
      result = await generateDomainCandidates({ name: product.name, description: product.description ?? "", features, scenarios });
    }
    const nameById = new Map(features.map((feature) => [feature.id, feature.name]));
    console.log(JSON.stringify({
      product: slug,
      featureCount: features.length,
      scenarioCount: scenarios.length,
      batches,
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
