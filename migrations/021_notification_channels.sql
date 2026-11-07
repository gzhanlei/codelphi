-- M1 通知分发：产品级通知渠道与投递记录。
-- target_encrypted 复用 lib/secret-box.ts 的 AES-256-GCM（密钥来自 SESSION_SECRET）。
-- deliveries 以 (analysis_run_id, channel_id) 唯一：同 run 重试只覆盖一条投递记录，天然去重。
CREATE TABLE IF NOT EXISTS notification_channels (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('slack', 'webhook') NOT NULL,
  target_encrypted TEXT NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY notification_channels_product_kind_unique (product_id, kind),
  CONSTRAINT notification_channels_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel_id BIGINT UNSIGNED NOT NULL,
  analysis_run_id BIGINT UNSIGNED NOT NULL,
  status ENUM('sent', 'failed') NOT NULL,
  error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY notification_deliveries_run_channel_unique (analysis_run_id, channel_id),
  CONSTRAINT notification_deliveries_channel_fk FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON DELETE CASCADE,
  CONSTRAINT notification_deliveries_run_fk FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
