CREATE TABLE IF NOT EXISTS spec_file_index (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  repository_id BIGINT UNSIGNED NOT NULL,
  spec_version_id BIGINT UNSIGNED NOT NULL,
  spec_feature_id BIGINT UNSIGNED NULL,
  spec_scenario_id BIGINT UNSIGNED NULL,
  path VARCHAR(500) NOT NULL,
  KEY spec_file_index_repo_path_idx (repository_id, path),
  KEY spec_file_index_version_idx (spec_version_id),
  CONSTRAINT spec_file_index_version_fk FOREIGN KEY (spec_version_id) REFERENCES spec_versions(id) ON DELETE CASCADE,
  CONSTRAINT spec_file_index_feature_fk FOREIGN KEY (spec_feature_id) REFERENCES spec_features(id) ON DELETE CASCADE,
  CONSTRAINT spec_file_index_scenario_fk FOREIGN KEY (spec_scenario_id) REFERENCES spec_scenarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
