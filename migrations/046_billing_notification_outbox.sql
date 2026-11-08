-- 计费通知 outbox（契约 M4-T4，P1-5）：业务事务内插入（唯一键保证事件不重复创建），
-- 独立投递（at-least-once：sent 后不重发；unknown 不清键不自动重发，进每日对账人工判断）。
-- idempotency_key = SHA256(account_id + billing_period + notification_type + threshold)。
CREATE TABLE IF NOT EXISTS billing_notification_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  idempotency_key CHAR(64) CHARACTER SET ascii NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  notification_type VARCHAR(48) NOT NULL,
  payload_json TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at DATETIME(3) NULL,
  UNIQUE KEY billing_outbox_idempotency_unique (idempotency_key),
  KEY billing_outbox_status_idx (status, created_at),
  CONSTRAINT billing_outbox_account_fk FOREIGN KEY (account_id) REFERENCES billing_accounts(account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
