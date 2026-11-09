import "dotenv/config";
import { grantQuotaByEmail } from "../lib/billing/manual-grant";

/**
 * 运营充值：给指定邮箱的用户（其个人工作区账户）的 Trial 钱包发放额度。
 * 账务语义与 core.grantTrialQuota 一致：granted 流水 + 钱包 remaining += units + 快照；
 * 幂等键 grt:manual:{reason}:{wallet_id}——重复执行撞唯一键自动跳过（不重复发放）。
 *
 * 用法:
 *   npx tsx scripts/billing-grant.ts <email> <units> <reason>
 * 例:
 *   npx tsx scripts/billing-grant.ts hanlei@gmail.com 200 manual-topup-2026-11-09
 */
async function main() {
  const [email, unitsArg, reasonArg] = process.argv.slice(2);
  if (!email || !unitsArg || !reasonArg) {
    console.error("usage: tsx scripts/billing-grant.ts <email> <units> <reason>");
    process.exit(1);
  }
  const units = Number(unitsArg);
  if (!Number.isInteger(units) || units <= 0) throw new Error(`units must be a positive integer: ${unitsArg}`);
  const result = await grantQuotaByEmail({ email, units, reason: reasonArg });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
