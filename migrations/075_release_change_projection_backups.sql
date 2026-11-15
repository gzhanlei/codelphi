CREATE TABLE IF NOT EXISTS release_change_projection_backups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  release_id BIGINT UNSIGNED NOT NULL,
  changes_json JSON NOT NULL,
  sources_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY release_change_projection_backups_release_idx (release_id),
  CONSTRAINT release_change_projection_backups_release_fk FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
