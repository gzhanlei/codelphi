-- Execution batch（081，§23 冻结契约）：plan set / plan / attempt / member / request 五张表，
-- 以及 llm_call_receipts 增可空 request_key/request_fingerprint/duration_ms（request_key 全局唯一）。
-- 纯增量迁移：只新增表、可空列与索引，不修改历史行。plan set/plan 表在 ready 之后 insert-only
-- 由应用层保证；成员/请求表与 attempts 之间是逻辑外键（跨 batch 表不建 DB 外键，与 080 同风格），
-- run_id 保留对 analysis_runs 的真实外键随 run 删除级联清理。

-- plan set：完整任务路由分配（batch + fallback）的唯一真源（§23.9）。fallback_assignments 与
-- plan_set_fingerprint 只保存在本表；building→ready 两阶段发布，只有 ready 可创建 batch attempt，
-- ready 后本表与 plans 表 insert-only。
CREATE TABLE IF NOT EXISTS analysis_behavior_batch_plan_sets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  plan_set_id VARCHAR(64) NOT NULL,
  plan_set_fingerprint CHAR(64) NOT NULL,
  planner_version VARCHAR(16) NOT NULL,
  expected_plan_count INT NOT NULL,
  expected_task_count INT NOT NULL,
  publish_status VARCHAR(16) NOT NULL DEFAULT 'building',
  fallback_assignments JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_behavior_batch_plan_sets_run_set_unique (run_id, plan_set_id),
  CONSTRAINT analysis_behavior_batch_plan_sets_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 单个 batch plan：只保存自身数据（batch_key/成员顺序/T 别名映射/分组指纹/预算快照），
-- 不重复保存 plan set 级的指纹或 fallback 分配（§23.9）。UNIQUE(run_id, batch_key) 保证
-- 相同规划内容重入幂等。
CREATE TABLE IF NOT EXISTS analysis_behavior_batch_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  plan_set_id VARCHAR(64) NOT NULL,
  batch_key CHAR(64) NOT NULL,
  manifest_hash CHAR(64) NOT NULL,
  planner_version VARCHAR(16) NOT NULL,
  ordered_task_keys JSON NOT NULL,
  task_alias_map JSON NOT NULL,
  grouping_rules_fingerprint CHAR(64) NOT NULL,
  input_budget_snapshot JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_behavior_batch_plans_run_batch_unique (run_id, batch_key),
  KEY analysis_behavior_batch_plans_run_set_idx (run_id, plan_set_id),
  CONSTRAINT analysis_behavior_batch_plans_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- batch attempt：执行真源；batch_attempt_uuid 同时充当预算聚合 attempt_id。
-- 一次 attempt 最多接受一次 describe 与一次 judge；模型重试必须创建新 attempt/reservation。
-- processing_owner + version 支撑恢复与拆分的双重 fencing（不替代 task lease）。
CREATE TABLE IF NOT EXISTS analysis_behavior_batch_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  batch_attempt_uuid CHAR(36) NOT NULL,
  batch_key CHAR(64) NOT NULL,
  reservation_uuid CHAR(36) NOT NULL,
  model_config_fingerprint CHAR(64) NOT NULL,
  prompt_version VARCHAR(16) NOT NULL,
  schema_version VARCHAR(16) NOT NULL,
  parser_version VARCHAR(16) NOT NULL,
  execution_phase VARCHAR(32) NOT NULL DEFAULT 'claiming',
  members_frozen_at DATETIME(3) NULL,
  accepted_describe_request_key VARCHAR(191) NULL,
  accepted_judge_request_key VARCHAR(191) NULL,
  terminal_request_key VARCHAR(191) NULL,
  processing_owner VARCHAR(191) NULL,
  processing_lease_expires_at DATETIME(3) NULL,
  last_error TEXT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_behavior_batch_attempts_run_uuid_unique (run_id, batch_attempt_uuid),
  UNIQUE KEY analysis_behavior_batch_attempts_reservation_unique (reservation_uuid),
  KEY analysis_behavior_batch_attempts_batch_key_idx (batch_key),
  CONSTRAINT analysis_behavior_batch_attempts_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 实际 claim 成功的成员：insert-only。UNIQUE(batch_attempt_uuid, task_key_hash) 防同 attempt
-- 重复成员；UNIQUE(request_task_attempt_id) 防同一 task attempt 挂到多个 batch attempt。
-- request_task_attempt_id 只做请求审计，提交资格始终来自当前 task row（§23.5 C5.2）。
CREATE TABLE IF NOT EXISTS analysis_behavior_batch_attempt_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  batch_attempt_uuid CHAR(36) NOT NULL,
  task_key VARCHAR(512) NOT NULL,
  task_key_hash CHAR(64) NOT NULL,
  request_task_attempt_id VARCHAR(64) NOT NULL,
  request_lease_identity VARCHAR(191) NOT NULL,
  task_alias VARCHAR(16) NOT NULL,
  ordered_region_aliases JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_behavior_batch_attempt_members_attempt_task_unique (batch_attempt_uuid, task_key_hash),
  UNIQUE KEY analysis_behavior_batch_attempt_members_task_attempt_unique (request_task_attempt_id),
  KEY analysis_behavior_batch_attempt_members_attempt_idx (batch_attempt_uuid),
  CONSTRAINT analysis_behavior_batch_attempt_members_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 每次实际发送的模型请求一行：request_key 全局唯一明文复合键（§23.1）。prepared 不代表已发送；
-- 原始响应（raw_response MEDIUMTEXT）按精确 UTF-8 字节保存，读回校验通过才进入 response_persisted。
-- failure_class 是 failed 行的费用判定必填项（§23.3 C3.2/C3.6）。
CREATE TABLE IF NOT EXISTS analysis_behavior_batch_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  batch_attempt_uuid CHAR(36) NOT NULL,
  request_key VARCHAR(191) NOT NULL,
  request_stage VARCHAR(16) NOT NULL,
  request_sequence INT NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  describe_response_hash CHAR(64) NULL,
  provider_request_id VARCHAR(191) NULL,
  request_outcome VARCHAR(24) NOT NULL DEFAULT 'prepared',
  failure_class VARCHAR(32) NULL,
  dispatch_started_at DATETIME(3) NULL,
  response_received_at DATETIME(3) NULL,
  confirmed_not_sent_at DATETIME(3) NULL,
  response_persisted_at DATETIME(3) NULL,
  raw_response MEDIUMTEXT NULL,
  response_byte_length INT NULL,
  stored_byte_length INT NULL,
  response_hash CHAR(64) NULL,
  provider_finish_reason VARCHAR(64) NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY analysis_behavior_batch_requests_key_unique (request_key),
  UNIQUE KEY analysis_behavior_batch_requests_attempt_stage_seq_unique (batch_attempt_uuid, request_stage, request_sequence),
  KEY analysis_behavior_batch_requests_attempt_idx (batch_attempt_uuid),
  CONSTRAINT analysis_behavior_batch_requests_run_fk FOREIGN KEY (run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- receipts 增可空请求身份（§23.3）：batch 请求必填 request_key 且全局唯一（幂等粒度=实际请求）；
-- 已知账务字段冲突矩阵（unknown→known 单调补全、已知值冲突报错）由应用层 reconcile-upsert 实现。
ALTER TABLE llm_call_receipts ADD COLUMN request_key VARCHAR(191) NULL AFTER call_stage;
ALTER TABLE llm_call_receipts ADD COLUMN request_fingerprint CHAR(64) NULL AFTER request_key;
ALTER TABLE llm_call_receipts ADD COLUMN duration_ms INT NULL AFTER request_fingerprint;
ALTER TABLE llm_call_receipts ADD UNIQUE KEY llm_call_receipts_request_key_unique (request_key);
