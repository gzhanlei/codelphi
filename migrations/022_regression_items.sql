-- M2 QA 回归清单：发布页行为变化的逐条勾选状态，跨会话持久、可导出。
CREATE TABLE IF NOT EXISTS regression_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  release_id BIGINT UNSIGNED NOT NULL,
  spec_change_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'verified', 'skipped') NOT NULL DEFAULT 'pending',
  checked_by VARCHAR(320) NULL,
  checked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY regression_items_release_change_unique (release_id, spec_change_id),
  CONSTRAINT regression_items_release_fk FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
  CONSTRAINT regression_items_spec_change_fk FOREIGN KEY (spec_change_id) REFERENCES spec_changes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
