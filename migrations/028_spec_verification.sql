-- P1 规格核实生命周期：来源(source)/时效(stale_since)/确认(verified_at) 三维度独立。
-- 核实状态由 verified_at × stale_since 推导（不存状态列）：
--   未核实 = verified_at IS NULL；已核实 = verified_at IS NOT NULL AND stale_since IS NULL；
--   待重新核实 = verified_at IS NOT NULL AND stale_since IS NOT NULL。
-- 人工编辑清 verified_at 但不动 stale_since（修订 ≠ 核实）；核实动作同时清 stale_since。

ALTER TABLE features
  ADD COLUMN verified_at DATETIME(3) NULL,
  ADD COLUMN verified_by VARCHAR(320) NULL;

ALTER TABLE scenarios
  ADD COLUMN verified_at DATETIME(3) NULL,
  ADD COLUMN verified_by VARCHAR(320) NULL;

CREATE TABLE IF NOT EXISTS spec_verifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  entity_type ENUM('feature', 'scenario') NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  spec_version_id BIGINT UNSIGNED NULL,
  commit_sha VARCHAR(64) NULL,
  verified_by VARCHAR(320) NOT NULL,
  verified_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY spec_verifications_entity_idx (entity_type, entity_id),
  KEY spec_verifications_product_idx (product_id),
  CONSTRAINT spec_verifications_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
