import "dotenv/config";
import fs from "node:fs";
import { parseDomainsDocument, runBusinessDomainMigration } from "./salesbuddy-business-domain-migration";

/**
 * 通用业务域迁移 CLI（2026-11-17 通用化）：任意产品按审核后的候选 JSON 落地业务分组。
 * 映射文件 = 设置页「业务分组候选（AI 提案）→ 全部接受」输出的 JSON（数组或 { domains, ungroupedIds }）。
 * 用法：
 *   dry-run：  npx tsx scripts/business-domain-migration.ts --product <slug> --domains <candidates.json> [--incremental]
 *   写入：     追加 --apply（写入前自动备份到 artifacts/business-domain-backups/）
 *   增量并入： --incremental（已归属目标域的子功能保持不动，只移动新增/未分组功能）
 *   回滚：     --restore <backup.json> --apply
 * 未提供 --incremental 时严格语义：任何子功能已有父级即整体中止。
 */

const isCli = process.argv[1]?.endsWith("/business-domain-migration.ts");
if (isCli) {
  async function main() {
    const args = process.argv.slice(2);
    const flag = (name: string) => args.includes(name);
    const value = (name: string) => (flag(name) ? args[args.indexOf(name) + 1] : undefined);
    const productSlug = value("--product");
    const apply = flag("--apply");
    const incremental = flag("--incremental");
    const restoreFrom = value("--restore");
    const backupDir = value("--backupDir");
    if (!productSlug) {
      console.error("用法：npx tsx scripts/business-domain-migration.ts --product <slug> --domains <candidates.json> [--incremental] [--apply] [--restore <backup.json> --apply] [--backupDir <dir>]");
      process.exit(1);
    }
    let domains;
    let ungroupedIds;
    if (!restoreFrom) {
      const domainsFile = value("--domains");
      if (!domainsFile || !fs.existsSync(domainsFile)) {
        console.error("缺少 --domains <候选JSON文件>（设置页审核后导出）");
        process.exit(1);
      }
      const parsed = parseDomainsDocument(fs.readFileSync(domainsFile, "utf8"));
      if (parsed.errors.length > 0) {
        console.error(JSON.stringify({ ok: false, errors: parsed.errors }, null, 2));
        process.exit(2);
      }
      domains = parsed.domains;
      ungroupedIds = parsed.ungroupedIds;
      console.error(`已加载 ${domains.length} 个业务域、${domains.reduce((total, domain) => total + domain.featureIds.length, 0)} 个功能归属${ungroupedIds.length > 0 ? `、${ungroupedIds.length} 个不分组校验项` : ""}${incremental ? "（增量模式）" : ""}`);
    }
    const result = await runBusinessDomainMigration({ productSlug, domains, ungroupedIds, incremental, apply, restoreFrom, backupDir });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(2);
  }
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
