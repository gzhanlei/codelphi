-- 支付订单（契约 M3-T0/§11.0，P1 双状态列 + P4 退款子状态机）：
-- status = 平台原生支付态（pending/paid/fulfilled/failed/closed/refunded，fulfilled 为本地履约标记）；
-- refund_status = 退款子状态机（none/refund_pending/refund_submitted/refund_confirmed/refund_failed），互不覆写。
-- order_no = 本地商户单号 + Chandler 建单幂等键；platform_order_no = 平台单号（履约幂等键与 webhook 定位键）。
-- raw_notify = 最后一次 webhook 原文（只落库排查、不进日志）。
CREATE TABLE IF NOT EXISTS payment_orders (
  order_no CHAR(36) NOT NULL PRIMARY KEY,
  platform_order_no VARCHAR(64) NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,
  plan_id VARCHAR(32) NULL,
  pack_sku VARCHAR(32) NULL,
  duration_months INT NULL,
  units INT NULL,
  channel VARCHAR(16) NOT NULL,
  amount INT NOT NULL,
  currency CHAR(8) NOT NULL DEFAULT 'CNY',
  subject VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  refund_status VARCHAR(16) NOT NULL DEFAULT 'none',
  refund_amount INT NULL,
  refund_reason VARCHAR(255) NULL,
  prepay_code_url TEXT NULL,
  prepay_pay_url TEXT NULL,
  prepay_h5_url TEXT NULL,
  raw_notify TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at DATETIME(3) NULL,
  fulfilled_at DATETIME(3) NULL,
  UNIQUE KEY payment_orders_platform_unique (platform_order_no),
  UNIQUE KEY payment_orders_idempotency_unique (order_no),
  KEY payment_orders_account_created_idx (account_id, created_at),
  KEY payment_orders_status_idx (status, created_at),
  KEY payment_orders_refund_status_idx (refund_status),
  CONSTRAINT payment_orders_account_fk FOREIGN KEY (account_id) REFERENCES billing_accounts(account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
