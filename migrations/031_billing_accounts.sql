-- 计费主体与 usage 采集基座（M0-T1，契约 docs/codelphi-billing-ledger-contract.md §2/§4.8）。
-- account_id = organizations.id（BIGINT，对齐 008_multi_tenant 实际类型；契约 CHAR(36) 假设按库实际类型偏离，已记录于契约偏离清单）。
-- 账户状态为到期制（V1.3 §7.0）：trialing/active/grace/expired；钱包是余额唯一事实源，账户表只存账户级元数据。
CREATE TABLE IF NOT EXISTS billing_accounts (
  account_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  plan_id VARCHAR(32) NOT NULL DEFAULT 'trial',
  plan_status VARCHAR(16) NOT NULL DEFAULT 'trialing',
  current_period_start DATETIME(3) NULL,
  current_period_end DATETIME(3) NULL,
  grace_until DATETIME(3) NULL,
  reconciliation_hold TINYINT(1) NOT NULL DEFAULT 0,
  currency CHAR(8) NOT NULL DEFAULT 'CNY',
  version INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT billing_accounts_organization_fk FOREIGN KEY (account_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 存量组织全部回填 trialing 账户（幂等：NOT EXISTS 防重；Trial 额度钱包回填见后续脚本）
INSERT INTO billing_accounts (account_id)
SELECT o.id FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM billing_accounts b WHERE b.account_id = o.id);

-- analysis_runs 计费扩展（契约 §4.8）：结算归属固化（结算禁止执行期读 cookie）+ 心跳 + attempt 权威值
ALTER TABLE analysis_runs
  ADD COLUMN account_id BIGINT UNSIGNED NULL,
  ADD COLUMN last_heartbeat_at DATETIME(3) NULL,
  ADD COLUMN billing_reservation_attempt INT NOT NULL DEFAULT 0,
  ADD KEY analysis_runs_account_idx (account_id),
  ADD CONSTRAINT analysis_runs_account_fk FOREIGN KEY (account_id) REFERENCES organizations(id);

-- 存量 run 归属回填：run → repository → product → organization（部署时刻 queued/running 一并回填，不允许 NULL 悬挂）
UPDATE analysis_runs r
JOIN repositories repo ON repo.id = r.repository_id
JOIN products p ON p.id = repo.product_id
SET r.account_id = p.organization_id
WHERE r.account_id IS NULL;
