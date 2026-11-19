-- 行为清单全量分析（080）：run 级不可变 manifest、执行任务回执、锚点-局部场景关联、共享预算账本。
-- 只新增表与可空列，不修改历史行；仅依赖既有 analysis_runs（001）与 spec_scenarios（002）。

-- run 级 manifest：manifest_json 是恢复时唯一有效的单元清单来源，insert-only——
-- 同 run 同 hash 重入幂等，同 run 不同 manifest 由应用层抛 inventory_version_conflict，
-- 本表绝不 UPDATE/REPLACE。inventory_generated_at 是数据库元数据（DB 默认时间戳），
-- 不进入确定性 manifest hash。
CREATE TABLE IF NOT EXISTS analysis_behavior_manifests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  after_sha VARCHAR(64) NOT NULL,
  scope_fingerprint VARCHAR(64) NOT NULL,
  inventory_schema_version VARCHAR(32) NOT NULL,
  detector_registry_version VARCHAR(191) NOT NULL,
  manifest_json JSON NOT NULL,
  manifest_hash CHAR(64) NOT NULL,
  inventory_generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_behavior_manifests_run_unique (run_id),
  CONSTRAINT analysis_behavior_manifests_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 执行任务回执：task_key/unit_key 是长逻辑键（含 path/symbol/区间），保存原文，
-- 唯一性与索引走 SHA-256 派生列（InnoDB 索引长度限制）。UNIQUE(run_id, task_key_hash)
-- 保证执行任务记录与结果提交幂等；租约三列支撑崩溃恢复与陈旧尝试隔离。
CREATE TABLE IF NOT EXISTS analysis_behavior_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  task_key VARCHAR(512) NOT NULL,
  task_key_hash CHAR(64) NOT NULL,
  unit_key VARCHAR(512) NOT NULL,
  unit_key_hash CHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  primary_path VARCHAR(1024) NOT NULL,
  primary_ranges JSON NULL,
  context_ranges JSON NOT NULL,
  anchor_fragments JSON NOT NULL,
  anchor_receipts JSON NULL,
  result_json JSON NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  scenario_count INT NOT NULL DEFAULT 0,
  reviewed_count INT NOT NULL DEFAULT 0,
  unresolved_anchor_count INT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(191) NULL,
  lease_expires_at DATETIME(3) NULL,
  attempt_id VARCHAR(64) NULL,
  detector VARCHAR(64) NOT NULL,
  detector_version VARCHAR(32) NOT NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_behavior_tasks_run_task_unique (run_id, task_key_hash),
  KEY analysis_behavior_tasks_run_status_idx (run_id, status),
  KEY analysis_behavior_tasks_run_unit_status_idx (run_id, unit_key_hash, status),
  KEY analysis_behavior_tasks_lease_idx (lease_expires_at, status),
  CONSTRAINT analysis_behavior_tasks_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 锚点结论 ↔ 局部场景多对多关联：final_scenario_id 指向最终规格的 spec_scenarios
-- （合并后回填；不是 live scenarios 表），规格场景被删时映射回退为空而非删除结论。
-- 唯一约束防止同一锚点重复关联同一局部场景。
CREATE TABLE IF NOT EXISTS analysis_behavior_anchor_scenarios (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  unit_key VARCHAR(512) NOT NULL,
  unit_key_hash CHAR(64) NOT NULL,
  anchor_key VARCHAR(512) NOT NULL,
  anchor_key_hash CHAR(64) NOT NULL,
  local_scenario_key VARCHAR(1024) NOT NULL,
  local_scenario_key_hash CHAR(64) NOT NULL,
  final_scenario_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_behavior_anchor_scenarios_link_unique (run_id, anchor_key_hash, local_scenario_key_hash),
  KEY analysis_behavior_anchor_scenarios_final_idx (final_scenario_id),
  CONSTRAINT analysis_behavior_anchor_scenarios_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE,
  CONSTRAINT analysis_behavior_anchor_scenarios_final_fk FOREIGN KEY (final_scenario_id) REFERENCES spec_scenarios(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 共享预算账本（D9）：三类上限、预留量、实际结算量、currency、summary 预留位与
-- 乐观锁版本号。所有预留与结算必须用条件 UPDATE（版本号或余额谓词），
-- 禁止先 SELECT 余额再由应用层无条件写入。
CREATE TABLE IF NOT EXISTS analysis_run_budgets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  max_llm_calls INT NOT NULL,
  max_total_tokens BIGINT UNSIGNED NOT NULL,
  max_cost_amount DECIMAL(12,6) NOT NULL,
  currency CHAR(8) NOT NULL DEFAULT 'CNY',
  reserved_llm_calls INT NOT NULL DEFAULT 0,
  reserved_input_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reserved_output_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reserved_cost_amount DECIMAL(12,6) NOT NULL DEFAULT 0,
  settled_llm_calls INT NOT NULL DEFAULT 0,
  settled_input_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  settled_output_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  settled_cost_amount DECIMAL(12,6) NOT NULL DEFAULT 0,
  summary_reserved TINYINT(1) NOT NULL DEFAULT 0,
  version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_run_budgets_run_unique (run_id),
  CONSTRAINT analysis_run_budgets_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 单元级 LLM 回执元数据（Task 6 写入）：旧调用与历史行保持 NULL；重复执行不得删除回执。
ALTER TABLE llm_call_receipts
  ADD COLUMN task_key VARCHAR(512) NULL AFTER call_kind,
  ADD COLUMN unit_key VARCHAR(512) NULL AFTER task_key,
  ADD COLUMN attempt_id VARCHAR(64) NULL AFTER unit_key,
  ADD COLUMN call_stage VARCHAR(24) NULL AFTER attempt_id;
