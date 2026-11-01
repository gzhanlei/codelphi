CREATE TABLE IF NOT EXISTS spec_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  repository_id BIGINT UNSIGNED NOT NULL,
  analysis_run_id BIGINT UNSIGNED NOT NULL,
  sha VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY spec_versions_analysis_run_unique (analysis_run_id),
  KEY spec_versions_repository_id_idx (repository_id, id),
  KEY spec_versions_product_id_idx (product_id, id),
  CONSTRAINT spec_versions_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT spec_versions_repository_fk FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  CONSTRAINT spec_versions_analysis_run_fk FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS spec_features (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  spec_version_id BIGINT UNSIGNED NOT NULL,
  stable_key VARCHAR(191) NOT NULL,
  name VARCHAR(191) NOT NULL,
  summary TEXT NOT NULL,
  parent_key VARCHAR(191) NULL,
  source VARCHAR(16) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  UNIQUE KEY spec_features_version_key_unique (spec_version_id, stable_key),
  CONSTRAINT spec_features_version_fk FOREIGN KEY (spec_version_id) REFERENCES spec_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS spec_scenarios (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  spec_feature_id BIGINT UNSIGNED NOT NULL,
  reference VARCHAR(32) NOT NULL,
  context TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  category VARCHAR(16) NOT NULL,
  source VARCHAR(16) NOT NULL,
  evidence JSON NOT NULL,
  UNIQUE KEY spec_scenarios_feature_reference_unique (spec_feature_id, reference),
  CONSTRAINT spec_scenarios_feature_fk FOREIGN KEY (spec_feature_id) REFERENCES spec_features(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS spec_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  spec_version_id BIGINT UNSIGNED NOT NULL,
  base_spec_version_id BIGINT UNSIGNED NULL,
  entity_type VARCHAR(16) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  feature_key VARCHAR(191) NOT NULL,
  feature_name VARCHAR(191) NOT NULL,
  scenario_reference VARCHAR(32) NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY spec_changes_version_entity_unique (spec_version_id, entity_type, feature_key, scenario_reference),
  KEY spec_changes_base_version_idx (base_spec_version_id),
  CONSTRAINT spec_changes_version_fk FOREIGN KEY (spec_version_id) REFERENCES spec_versions(id) ON DELETE CASCADE,
  CONSTRAINT spec_changes_base_version_fk FOREIGN KEY (base_spec_version_id) REFERENCES spec_versions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE releases ADD COLUMN spec_version_id BIGINT UNSIGNED NULL;
ALTER TABLE releases ADD UNIQUE KEY releases_spec_version_unique (spec_version_id);
ALTER TABLE releases ADD CONSTRAINT releases_spec_version_fk FOREIGN KEY (spec_version_id) REFERENCES spec_versions(id) ON DELETE SET NULL;
