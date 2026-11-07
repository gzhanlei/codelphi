-- P0 场景级回归任务：回归项 = 一次具体的场景验证任务，唯一粒度 (release, scenario)；
-- spec_change 作为变化来源多对多关联；推荐理由为可追溯关联记录（基线文档 P0 设计约束）。
-- 任务主体二选一：场景锚定（spec_scenario_id）或变化锚定（spec_change_id，用于被移除场景/功能级变化）。

CREATE TABLE IF NOT EXISTS release_files (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  release_id BIGINT UNSIGNED NOT NULL,
  path VARCHAR(500) NOT NULL,
  UNIQUE KEY release_files_unique (release_id, path),
  CONSTRAINT release_files_release_fk FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS regression_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  release_id BIGINT UNSIGNED NOT NULL,
  spec_scenario_id BIGINT UNSIGNED NULL,
  spec_change_id BIGINT UNSIGNED NULL,
  status ENUM('pending', 'passed', 'failed', 'skipped') NOT NULL DEFAULT 'pending',
  skip_reason VARCHAR(191) NULL,
  failure_note TEXT NULL,
  checked_by VARCHAR(320) NULL,
  checked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY regression_tasks_scenario_unique (release_id, spec_scenario_id),
  UNIQUE KEY regression_tasks_change_unique (release_id, spec_change_id),
  CONSTRAINT regression_tasks_subject_check CHECK ((spec_scenario_id IS NULL) + (spec_change_id IS NULL) = 1),
  CONSTRAINT regression_tasks_release_fk FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
  CONSTRAINT regression_tasks_scenario_fk FOREIGN KEY (spec_scenario_id) REFERENCES spec_scenarios(id) ON DELETE CASCADE,
  CONSTRAINT regression_tasks_change_fk FOREIGN KEY (spec_change_id) REFERENCES spec_changes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS regression_task_sources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  spec_change_id BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY regression_task_sources_unique (task_id, spec_change_id),
  CONSTRAINT regression_task_sources_task_fk FOREIGN KEY (task_id) REFERENCES regression_tasks(id) ON DELETE CASCADE,
  CONSTRAINT regression_task_sources_change_fk FOREIGN KEY (spec_change_id) REFERENCES spec_changes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS regression_task_reasons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  hit_type ENUM('behavior_change', 'evidence_path', 'feature_wide') NOT NULL,
  matched_path VARCHAR(500) NULL,
  spec_feature_id BIGINT UNSIGNED NULL,
  spec_scenario_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY regression_task_reasons_task_idx (task_id),
  CONSTRAINT regression_task_reasons_task_fk FOREIGN KEY (task_id) REFERENCES regression_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 回填：以每个发布 spec_version 的全部 spec_changes 为基准生成任务（保证历史发布回归清单完整），
-- 旧 regression_items（粒度 release+spec_change）仅用于继承勾选状态。
-- 场景级 added/changed 锚定到场景（spec_changes 有 (version, entity_type, feature_key, scenario_reference) 唯一键，与场景 1:1）；
-- 其余（移除场景、功能级变化）锚定到变化本身。verified → passed 对应四态语义。
INSERT IGNORE INTO regression_tasks (release_id, spec_scenario_id, spec_change_id, status, checked_by, checked_at)
SELECT r.id, ss.id, NULL,
       COALESCE(CASE ri.status WHEN 'verified' THEN 'passed' ELSE ri.status END, 'pending'),
       ri.checked_by, ri.checked_at
FROM releases r
JOIN spec_changes c ON c.spec_version_id = r.spec_version_id AND c.entity_type = 'scenario' AND c.kind <> 'removed'
JOIN spec_features sf ON sf.spec_version_id = c.spec_version_id AND sf.stable_key = c.feature_key
JOIN spec_scenarios ss ON ss.spec_feature_id = sf.id AND ss.reference = c.scenario_reference
LEFT JOIN regression_items ri ON ri.release_id = r.id AND ri.spec_change_id = c.id;

INSERT IGNORE INTO regression_tasks (release_id, spec_scenario_id, spec_change_id, status, checked_by, checked_at)
SELECT r.id, NULL, c.id,
       COALESCE(CASE ri.status WHEN 'verified' THEN 'passed' ELSE ri.status END, 'pending'),
       ri.checked_by, ri.checked_at
FROM releases r
JOIN spec_changes c ON c.spec_version_id = r.spec_version_id
LEFT JOIN spec_features sf ON sf.spec_version_id = c.spec_version_id AND sf.stable_key = c.feature_key
LEFT JOIN spec_scenarios ss ON ss.spec_feature_id = sf.id AND ss.reference = c.scenario_reference
     AND c.entity_type = 'scenario' AND c.kind <> 'removed'
LEFT JOIN regression_items ri ON ri.release_id = r.id AND ri.spec_change_id = c.id
WHERE ss.id IS NULL;

-- 来源：场景任务 ← 其直接行为变化；变化锚定任务 ← 自身。
INSERT INTO regression_task_sources (task_id, spec_change_id)
SELECT t.id, t.spec_change_id FROM regression_tasks t WHERE t.spec_change_id IS NOT NULL;

INSERT INTO regression_task_sources (task_id, spec_change_id)
SELECT t.id, c.id
FROM regression_tasks t
JOIN releases r ON r.id = t.release_id
JOIN spec_changes c ON c.spec_version_id = r.spec_version_id AND c.entity_type = 'scenario' AND c.kind <> 'removed'
JOIN spec_features sf ON sf.spec_version_id = c.spec_version_id AND sf.stable_key = c.feature_key
JOIN spec_scenarios ss ON ss.spec_feature_id = sf.id AND ss.reference = c.scenario_reference
WHERE t.spec_scenario_id = ss.id;

-- 理由：全部回填任务都源于行为变化。
INSERT INTO regression_task_reasons (task_id, hit_type, spec_feature_id, spec_scenario_id)
SELECT t.id, 'behavior_change', sf.id, t.spec_scenario_id
FROM regression_tasks t
LEFT JOIN spec_scenarios ss ON ss.id = t.spec_scenario_id
LEFT JOIN spec_features sf ON sf.id = ss.spec_feature_id
LEFT JOIN spec_changes c ON c.id = t.spec_change_id
LEFT JOIN spec_features cfi ON cfi.spec_version_id = c.spec_version_id AND cfi.stable_key = c.feature_key
WHERE COALESCE(sf.id, cfi.id) IS NOT NULL;

DROP TABLE regression_items;
