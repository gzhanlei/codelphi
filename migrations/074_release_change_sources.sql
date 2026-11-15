CREATE TABLE IF NOT EXISTS change_sources (
  change_id BIGINT UNSIGNED NOT NULL,
  spec_change_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (change_id, spec_change_id),
  UNIQUE KEY change_sources_spec_change_unique (spec_change_id),
  CONSTRAINT change_sources_change_fk FOREIGN KEY (change_id) REFERENCES changes(id) ON DELETE CASCADE,
  CONSTRAINT change_sources_spec_change_fk FOREIGN KEY (spec_change_id) REFERENCES spec_changes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS release_reviewed_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  release_id BIGINT UNSIGNED NOT NULL,
  feature_name VARCHAR(191) NOT NULL,
  description TEXT NOT NULL,
  evidence JSON NOT NULL,
  source_key CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY release_reviewed_items_source_unique (release_id, source_key),
  CONSTRAINT release_reviewed_items_release_fk FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
