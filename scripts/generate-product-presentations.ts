import "dotenv/config";
import { pathToFileURL } from "node:url";
import { getDb } from "../lib/db";
import { schedulePresentationRefresh, standalonePresentationBilling, type PresentationRefreshResult } from "../lib/product-presentation-service";

/**
 * 理解层（核心能力归纳 + 典型使用场景）存量回填。
 *
 * 分析钩子只覆盖「上线之后又有新分析」的产品；在此之前已有规格的产品需要显式回填。
 * 逐个产品同步生成并落库（走与线上相同的调度：行级租约、pending 标记），会真实调用模型，
 * 计费口径同独立生成（call_kind=product_presentation）。
 *
 * 用法：
 *   npx tsx scripts/generate-product-presentations.ts --product <slug> [--org <组织 id>]
 *   npx tsx scripts/generate-product-presentations.ts --public-demo
 *   npx tsx scripts/generate-product-presentations.ts --all
 * 任意组合追加 --dry-run 只列出目标，不调用模型。生产执行前先 --dry-run 核对清单与功能数。
 * 默认尊重规格指纹：规格没变的产品判定为「未变化」、零模型调用，所以脚本可以放心重复执行；
 * 追加 --force 才对已有理解层的产品重新生成（按当前规则重来：全新结果的覆盖面不输上一版仍然成立的部分时直接替换，否则与上一版合并）。
 */

interface Target { id: number; slug: string; name: string; features: number }

function usage() {
  console.error("用法: generate-product-presentations.ts (--product <slug> [--org <id>] | --public-demo | --all) [--dry-run] [--force]");
  return 2;
}

function parseArgs(argv: string[]) {
  const options: { product?: string; org?: number; publicDemo: boolean; all: boolean; dryRun: boolean; force: boolean } = { publicDemo: false, all: false, dryRun: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--product") options.product = argv[++index];
    else if (arg === "--org") options.org = Number(argv[++index]);
    else if (arg === "--public-demo") options.publicDemo = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else return null;
  }
  if (options.product === "") return null;
  if (options.org !== undefined && !Number.isSafeInteger(options.org)) return null;
  if (!options.product && !options.publicDemo && !options.all) return null;
  return options;
}

type BackfillOptions = NonNullable<ReturnType<typeof parseArgs>>;

async function resolveTargets(options: BackfillOptions): Promise<Target[]> {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options.product) {
    conditions.push("p.slug = ?");
    params.push(options.product);
    if (options.org !== undefined) {
      conditions.push("p.organization_id = ?");
      params.push(options.org);
    }
  } else if (options.publicDemo) {
    conditions.push("p.is_public_demo = 1");
  }
  // 只回填已有活跃功能的产品：没有规格的产品没有可归纳的东西。
  conditions.push("EXISTS (SELECT 1 FROM features f WHERE f.product_id = p.id AND f.active = 1)");
  const [rows] = await getDb().execute(
    `SELECT p.id, p.slug, p.name, (SELECT COUNT(*) FROM features f WHERE f.product_id = p.id AND f.active = 1) AS features
     FROM products p ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY p.id`,
    params,
  );
  return (rows as Target[]).map((row) => ({ ...row, id: Number(row.id), features: Number(row.features) }));
}

export async function runPresentationBackfill(argv: string[], deps: { resolve: (options: BackfillOptions) => Promise<Target[]>; refresh: (productId: number, force: boolean) => Promise<PresentationRefreshResult> }) {
  const options = parseArgs(argv);
  if (!options) return usage();
  const targets = await deps.resolve(options);
  if (targets.length === 0) {
    console.log("[presentation-backfill] 没有符合条件的产品（只处理已有活跃功能的产品）");
    return 0;
  }
  console.log(`[presentation-backfill] ${options.dryRun ? "待回填" : "回填"} ${targets.length} 个产品`);
  for (const target of targets) console.log(`  - #${target.id} ${target.slug}（${target.name}）· ${target.features} 个功能`);
  if (options.dryRun) return 0;
  const tally = { generated: 0, unchanged: 0, failed: 0, other: 0 };
  for (const target of targets) {
    const result = await deps.refresh(target.id, options.force);
    if (result.outcome === "generated") tally.generated += 1;
    else if (result.outcome === "unchanged") tally.unchanged += 1;
    else if (result.outcome === "failed") tally.failed += 1;
    else tally.other += 1;
    console.log(`[presentation-backfill] #${target.id} ${target.slug} → ${result.outcome}${result.reason ? `（${result.reason}）` : ""}${result.detail ? ` ${JSON.stringify(result.detail)}` : ""}`);
  }
  console.log("[presentation-backfill] 完成", tally);
  return tally.failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runPresentationBackfill(process.argv.slice(2), {
    resolve: resolveTargets,
    refresh: async (productId, force) => schedulePresentationRefresh({ productId, force, background: false, billing: standalonePresentationBilling() }),
  }).then(async (code) => {
    await getDb().end().catch(() => undefined);
    process.exitCode = code;
  }).catch(async (error: unknown) => {
    console.error("[presentation-backfill] 未处理错误", error);
    await getDb().end().catch(() => undefined);
    process.exitCode = 1;
  });
}
