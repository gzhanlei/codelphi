-- GitHub webhook 投递幂等（契约 M1-T3 两阶段持久化，P0-4）：
-- 阶段一（独立事务）落 received 防重复接收；阶段二同事务完成 run 创建 + 预留 + queued；
-- 崩溃后重投对 received/processing/failed_retryable 续处理，queued/skipped 幂等返回原结果。
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id VARCHAR(64) NOT NULL PRIMARY KEY,
  event_type VARCHAR(32) NOT NULL DEFAULT 'push',
  status VARCHAR(16) NOT NULL DEFAULT 'received',
  run_id BIGINT UNSIGNED NULL,
  result_json TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY github_webhook_deliveries_status_idx (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
