-- B1 覆盖披露（docs/specsight-gap-improvement-plan.md §5.1）：
-- 分析覆盖率回执，append-only，按 spec_version 关联可回溯历史版本当时的覆盖率。
-- 口径只有一个：本规格版本对应的完整实现面（evidenceKind 分级 implementation 文件）；
-- run 类型（首分析 / 增量 / RC2-carry）仅作诊断元数据，不另设门槛。
CREATE TABLE IF NOT EXISTS analysis_coverage_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  spec_version_id BIGINT UNSIGNED NOT NULL,
  impl_files_assembled INT UNSIGNED NOT NULL,
  impl_files_total INT UNSIGNED NOT NULL,
  impl_bytes_assembled BIGINT UNSIGNED NOT NULL,
  impl_bytes_total BIGINT UNSIGNED NOT NULL,
  coverage_ratio DECIMAL(6, 4) NOT NULL,
  partitions_used INT UNSIGNED NOT NULL,
  partitions_capped TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_coverage_receipts_version_unique (spec_version_id),
  CONSTRAINT analysis_coverage_receipts_version_fk FOREIGN KEY (spec_version_id) REFERENCES spec_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
