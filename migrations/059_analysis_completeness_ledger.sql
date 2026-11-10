-- R1 分析完整性账本：run 级六维度完整性状态（分析成功 ≠ 完整 ≠ 正确，禁止单一百分比）。
-- 六维度：source coverage / behavioral enumeration / extraction completion /
-- evidence integrity / merge integrity / verification；overall = 最差维度。
CREATE TABLE IF NOT EXISTS analysis_completeness_ledger (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  source_coverage ENUM('complete','partial','failed','not_applicable') NOT NULL,
  behavioral_enumeration ENUM('complete','partial','failed','not_applicable') NOT NULL,
  extraction_completion ENUM('complete','partial','failed','not_applicable') NOT NULL,
  evidence_integrity ENUM('complete','partial','failed','not_applicable') NOT NULL,
  merge_integrity ENUM('complete','partial','failed','not_applicable') NOT NULL,
  verification ENUM('complete','partial','failed','not_applicable') NOT NULL,
  overall ENUM('complete','partial','failed','not_applicable') NOT NULL,
  details JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_completeness_ledger_run_unique (run_id),
  CONSTRAINT analysis_completeness_ledger_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
