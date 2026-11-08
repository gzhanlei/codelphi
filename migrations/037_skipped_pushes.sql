-- 自动 push 因额度/闸门被跳过的台账（契约 §8.2/§12.4）：触顶静默跳过、零费用、不重试风暴；
-- Dashboard 展示跳过数与规格漂移区间，「补分析最新 SHA」入口依据本表（M4-T3）。
CREATE TABLE IF NOT EXISTS skipped_pushes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  repository_id BIGINT UNSIGNED NOT NULL,
  sha VARCHAR(64) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  delivery_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY skipped_pushes_repository_created_idx (repository_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
