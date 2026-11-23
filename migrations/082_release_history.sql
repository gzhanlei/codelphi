ALTER TABLE analysis_runs
  ADD COLUMN base_spec_version_id BIGINT UNSIGNED NULL,
  ADD COLUMN base_captured_at DATETIME(3) NULL,
  ADD KEY analysis_runs_base_version_idx (base_spec_version_id),
  ADD CONSTRAINT analysis_runs_base_version_fk FOREIGN KEY (base_spec_version_id) REFERENCES spec_versions(id) ON DELETE SET NULL;

ALTER TABLE spec_versions
  ADD COLUMN base_spec_version_id BIGINT UNSIGNED NULL AFTER analysis_run_id,
  ADD KEY spec_versions_base_version_idx (base_spec_version_id),
  ADD CONSTRAINT spec_versions_base_version_fk FOREIGN KEY (base_spec_version_id) REFERENCES spec_versions(id) ON DELETE SET NULL;

ALTER TABLE releases
  ADD COLUMN is_current TINYINT(1) NOT NULL DEFAULT 0,
  ADD KEY releases_repository_current_idx (repository_id, is_current);

UPDATE releases r
JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY repository_id ORDER BY analysis_run_id DESC, id DESC) AS position
  FROM releases
) ranked ON ranked.id = r.id
SET r.is_current = ranked.position = 1;
