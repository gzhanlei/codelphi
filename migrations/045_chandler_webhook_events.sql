-- Chandler webhook 事件台账（契约 P5）：先落库再处理——三元组唯一键防重复事件，
-- 重复投递直接 ACK 跳过；处理推进由订单状态机兜底（重复迁移零副作用）。
CREATE TABLE IF NOT EXISTS chandler_webhook_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  platform_order_no VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  body_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY chandler_webhook_events_dedupe_unique (platform_order_no, status, body_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
