#!/usr/bin/env tsx
import "dotenv/config";
import mysql, { type Pool } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { backfillImportDraft, blockagesOf, ImportBackfillRefused, loadBackfillCandidate, type BackfillBlockage, type BackfillOptions, type DraftBackfillCandidate, type ImportBackfillReceipt } from "../lib/import-draft-backfill";
import { CONTRACT_VERSION } from "../lib/extraction-contract";

/**
 * 把快照导入产生的草稿回填成第一个规格版本（原规格 §16.3 路径 B；修订稿 §4.2「旧客户端迁移」）。
 *
 * 不读源码、不调模型、不访问网络。走的是托管分析同一个合并入口，所以写出来的东西和一次托管的首分析同形。
 *
 * 用法：
 *   npx tsx scripts/backfill-import-draft.ts --slug <产品 slug> --org <组织号> [--committed-at <ISO 8601>] [--apply]
 *        [--accept-contract-drift] [--accept-dedupe] [--json]
 *
 * 默认演练：在事务里真做一遍，然后回滚，报告实际会写出什么。一个字节都不留。
 * 加 --apply 才提交，而且必须同时给 --committed-at：服务端不知道那个提交是什么时候提交的，
 * 发布上显示的时间只能由调用方给，这里不拿导入时间冒充。
 *
 * 演练和写入都会短暂锁住这个产品：先锁产品行，再锁它的仓库行。大草稿要跑几秒到十几秒。
 *
 * 遇到下面两种情况，写入会被拒绝，除非看过了演练报告、明确加上对应的开关：
 *   --accept-contract-drift  导入时的提取契约和现在的不一样。
 *   --accept-dedupe          有草稿场景和另一条文字、证据路径都完全一样，合并入口会去掉它们，
 *                            这些行也会从工作台上消失（行还在，停用了）。
 */

export interface BackfillArgs {
  slug: string | null;
  organizationId: number | null;
  committedAt: string | null;
  apply: boolean;
  acceptContractDrift: boolean;
  acceptDedupe: boolean;
  json: boolean;
}

const USAGE = "用法：npx tsx scripts/backfill-import-draft.ts --slug <产品 slug> --org <组织号> [--committed-at <ISO 8601>] [--apply] [--accept-contract-drift] [--accept-dedupe] [--json]";

export function parseArgs(argv: readonly string[]): BackfillArgs {
  const args: BackfillArgs = { slug: null, organizationId: null, committedAt: null, apply: false, acceptContractDrift: false, acceptDedupe: false, json: false };
  const valueOf = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index < 0) return null;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} 后面要跟一个值\n${USAGE}`);
    return value;
  };
  args.slug = valueOf("--slug");
  const organization = valueOf("--org");
  args.organizationId = organization === null ? null : /^\d+$/.test(organization) ? Number(organization) : Number.NaN;
  args.committedAt = valueOf("--committed-at");
  args.apply = argv.includes("--apply");
  args.acceptContractDrift = argv.includes("--accept-contract-drift");
  args.acceptDedupe = argv.includes("--accept-dedupe");
  args.json = argv.includes("--json");
  return args;
}

/** 用法上的错在连数据库之前就报出来。 */
export function usageProblems(args: BackfillArgs): string[] {
  const problems: string[] = [];
  if (!args.slug) problems.push("要用 --slug 指定产品");
  if (args.organizationId === null) problems.push("要用 --org 指定产品所在的组织号");
  else if (Number.isNaN(args.organizationId) || args.organizationId <= 0) problems.push("--org 要是一个正整数");
  // 不给提交时间也可以演练；写入不行。
  if (args.apply && !args.committedAt) problems.push("--apply 必须同时给 --committed-at（那个提交的提交时间）：服务端不知道它，发布上显示的时间只能由你给出");
  return problems;
}

const short = (sha: string | null) => (sha ? `${sha.slice(0, 12)}…` : "无");

function utc(date: Date | string): string {
  return `${new Date(date).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** 给人看的条件。拒不变动库之前先把看到的事实列出来，拒绝的原因才对得上号。 */
export function renderCandidate(candidate: DraftBackfillCandidate | null): string {
  if (!candidate) return "产品：没有找到\n";
  const { repository, seeded, workbench } = candidate;
  const count = (table: "features" | "scenarios", source: string, state: "active" | "inactive") => workbench[table][`${source}:${state}`] ?? 0;
  return [
    `产品        ${candidate.slug}（#${candidate.productId}，组织 ${candidate.organizationId}）${candidate.productName} · 输出语言 ${candidate.outputLanguage} · 现在由 ${candidate.analysisExecutor} 分析`,
    `仓库        ${repository ? `#${repository.id} ${repository.provider} ${repository.owner}/${repository.name}${repository.host ? `（主机 ${repository.host}）` : ""}` : "没有"}（共 ${candidate.repositoryCount} 条）`,
    `快照        提交 ${short(seeded.snapshotSha)} · 树 ${short(seeded.treeSha)} · ${seeded.dirty ? "工作区有未提交改动" : "工作区干净"} · 契约 ${seeded.contractVersion ?? "未登记"}（现在 ${CONTRACT_VERSION}）· 导入于 ${seeded.importedAt ? utc(seeded.importedAt) : "未知"}`,
    `工作台      导入 ${count("features", "ai_snapshot_import", "active")} 个功能 / ${count("scenarios", "ai_snapshot_import", "active")} 个场景在用，${count("features", "ai_snapshot_import", "inactive")} / ${count("scenarios", "ai_snapshot_import", "inactive")} 已停用`,
    `            人工 ${count("features", "manual", "active")} / ${count("scenarios", "manual", "active")} 在用；分析产生 ${count("features", "generated", "active")} / ${count("scenarios", "generated", "active")}`,
    `已有版本    ${candidate.versionCount}`,
  ].join("\n") + "\n";
}

export function renderBlockages(blockages: readonly BackfillBlockage[]): string {
  return ["不能回填：", ...blockages.map((blockage) => `  - ${blockage.code}：${blockage.detail}`)].join("\n") + "\n";
}

export function renderReceipt(receipt: ImportBackfillReceipt): string {
  const head = receipt.dryRun
    ? "事务里做出来的结果（演练，已经回滚，库里没有变化）。确认无误后加 --apply 写入。"
    : "已写入（事务已提交）。";
  const lines = [
    head,
    `  run          #${receipt.runId}（${receipt.dryRun ? "将写入" : "已写入"}，import_backfill：一条回执，提交时就是完成，服务端不执行）`,
    `  规格版本     #${receipt.specVersionId}：${receipt.version.features} 个功能 / ${receipt.version.scenarios} 个场景，其中人工 ${receipt.version.manualFeatures} / ${receipt.version.manualScenarios}`,
    `  发布         #${receipt.releaseId}，登记在提交 ${short(receipt.revisionSha)}，提交时间 ${utc(receipt.committedAt)}（由 --committed-at 给出，服务端自己不知道）`,
    `  发布页条目   ${receipt.releaseChanges}（首个版本把每个功能都列为「新增」）`,
    `  草稿         ${receipt.draft.features} 个功能 / ${receipt.draft.scenarios} 个场景，其中 ${receipt.draft.withoutEvidence} 条场景没有证据（原样带着）`,
    `  被去掉的草稿场景 ${receipt.droppedDraft.length}${receipt.droppedDraft.length > 0 ? `，例如 ${receipt.droppedDraft.slice(0, 5).map((item) => `${item.feature}#${item.reference}`).join("、")}` : ""}`,
    `  来源         草稿行的来源在同一事务里改成 generated；行号不变；版本带来源信息（客户端分析、由导入回填、服务端未做核对）`,
  ];
  if (receipt.droppedDraft.length > 0 && receipt.dryRun) lines.push("  这些行回填后会从工作台上消失。接受这一点再加 --accept-dedupe。");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const problems = usageProblems(args);
  if (problems.length > 0) {
    console.error(`${(problems.length === 1 ? [problems[0]] : ["参数不对：", ...problems]).join("\n")}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const target = { slug: args.slug as string, organizationId: args.organizationId as number };
  const options: BackfillOptions & { apply: boolean } = {
    apply: args.apply,
    // 演练可以不给提交时间。占一个明显是占位的值：事务反正会回滚，报告里也不印它。
    committedAt: args.committedAt ?? new Date(0).toISOString(),
    currentContractVersion: CONTRACT_VERSION,
    acceptContractDrift: args.acceptContractDrift,
    acceptDedupe: args.acceptDedupe,
  };
  const pool = mysql.createPool(databaseConfig());
  try {
    const candidate = await loadBackfillCandidate((statement, parameters) => pool.execute(statement, parameters), target);
    const blockages = candidate ? blockagesOf(candidate, options) : [{ code: "product_not_found" as const, detail: `组织 ${target.organizationId} 里没有叫 ${target.slug} 的产品` }];
    const machine: Record<string, unknown> = { mode: args.apply ? "apply" : "dry-run", candidate, blockages };
    if (blockages.length > 0) {
      if (args.json) console.log(JSON.stringify(machine, null, 2));
      else console.log([renderCandidate(candidate), renderBlockages(blockages)].join("\n"));
      process.exitCode = 1;
      return;
    }
    try {
      const receipt = await backfillImportDraft(pool, target, options);
      if (args.json) console.log(JSON.stringify({ ...machine, receipt }, null, 2));
      else console.log([renderCandidate(candidate), renderReceipt(receipt)].join("\n"));
    } catch (error) {
      // 演练报告之后草稿又变了，或者有人没看演练就直接写入并撞上去重。
      if (!(error instanceof ImportBackfillRefused)) throw error;
      if (args.json) console.log(JSON.stringify({ ...machine, refused: error.blockages }, null, 2));
      else console.log([renderCandidate(candidate), renderBlockages(error.blockages)].join("\n"));
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("backfill-import-draft.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
