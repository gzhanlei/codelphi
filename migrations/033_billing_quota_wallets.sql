-- 额度钱包（契约 §4.1）：余额唯一事实源（remaining 含预留中未结清部分；available = remaining - reserved）。
-- quota_type：trial / plan / gift / pack；plan 钱包有效性由 period_id 关联账户当前周期（契约 §3.2）。
-- source_key 唯一约束（D9）：同一履约来源不可能建出第二个钱包，grant 幂等的库级兜底。
CREATE TABLE IF NOT EXISTS billing_quota_wallets (
  wallet_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  quota_type VARCHAR(16) NOT NULL,
  remaining_sau INT NOT NULL DEFAULT 0,
  reserved_sau INT NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NULL,
  period_id VARCHAR(64) NULL,
  source_key VARCHAR(191) COLLATE utf8mb4_bin NULL,
  source_order_no VARCHAR(64) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  balance_after_remaining INT NOT NULL DEFAULT 0,
  balance_after_reserved INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY billing_wallets_source_key_unique (source_key),
  KEY billing_wallets_account_idx (account_id),
  CONSTRAINT billing_wallets_balance_check CHECK (remaining_sau >= 0 AND reserved_sau >= 0 AND reserved_sau <= remaining_sau),
  CONSTRAINT billing_wallets_account_fk FOREIGN KEY (account_id) REFERENCES billing_accounts(account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
