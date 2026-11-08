-- Trial 授权台账（契约 M1-T4，P1-3 归属冻结）：归属主体 = 创建个人工作区的用户；
-- user_id 唯一约束兜并发发放（同一用户并发建两个工作区只发放一次）；
-- 授权永久保留原始 user_id + account_id 关联；owner 转移不迁移 Trial 权益。
CREATE TABLE IF NOT EXISTS trial_grants (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  granted_units INT NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'workspace_creation',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT trial_grants_account_fk FOREIGN KEY (account_id) REFERENCES billing_accounts(account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
