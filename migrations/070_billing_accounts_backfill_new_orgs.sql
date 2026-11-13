-- 2026-11-13 P0 回填：migration 031 的 billing_accounts 回填只覆盖部署时点存量组织，
-- 此后新建组织（ensureUserWorkspace 个人工作区等）缺行 → trial 钱包外键失败（发放整
-- 事务回滚）、首次分析在 reserve 抛 billing_state_conflict。代码侧兜底见
-- lib/organizations.ts ensureBillingAccountRow；本迁移一次性补齐 031 之后的漏网组织。
-- 幂等：NOT EXISTS 防重，与 031 同款写法。
INSERT INTO billing_accounts (account_id)
SELECT o.id FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM billing_accounts b WHERE b.account_id = o.id);
