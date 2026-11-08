-- 预留与结算状态族（契约 §4.3–§4.7，D1/D8/D12–D20）。
-- billing_reservations：预留的可变状态表（D1）——TTL 续期唯一落点，ledger 只记不可变事实。
CREATE TABLE IF NOT EXISTS billing_reservations (
  reservation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  reservation_attempt INT NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  wallet_id BIGINT UNSIGNED NOT NULL,
  units INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY billing_reservations_run_attempt_wallet_unique (run_id, reservation_attempt, wallet_id),
  KEY billing_reservations_status_expires_idx (status, expires_at),
  KEY billing_reservations_run_idx (run_id),
  CONSTRAINT billing_reservations_units_positive_check CHECK (units > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- billing_settlements：attempt 级闭合记录（D8）——capture 幂等的权威结算结果；
-- 只为发生 capture 的 attempt 创建（released/expired attempt 的终结由 reservations 状态判断，§4.4）。
CREATE TABLE IF NOT EXISTS billing_settlements (
  settlement_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  reservation_attempt INT NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  original_units INT NOT NULL,
  captured_units INT NOT NULL DEFAULT 0,
  released_units INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'settled',
  via VARCHAR(16) NOT NULL DEFAULT 'normal',
  per_wallet_json TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY billing_settlements_run_attempt_unique (run_id, reservation_attempt),
  KEY billing_settlements_account_idx (account_id),
  CONSTRAINT billing_settlements_non_negative_check CHECK (original_units >= 0 AND captured_units >= 0 AND released_units >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- billing_settlement_requests：run 级结算请求权威（D8）——一 run 一条，requested_actual_units 跨 attempt 不变；
-- run_settlement_status 三态映射见契约 §4.5（D20）：captured=0 且 unfunded>0 → unfunded。
CREATE TABLE IF NOT EXISTS billing_settlement_requests (
  request_id CHAR(36) NOT NULL PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  requested_actual_units INT NOT NULL,
  captured_units_total INT NOT NULL DEFAULT 0,
  released_units_total INT NOT NULL DEFAULT 0,
  unfunded_units INT NOT NULL DEFAULT 0,
  run_settlement_status VARCHAR(16) NOT NULL,
  attempts_used_json TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY billing_settlement_requests_run_unique (run_id),
  CONSTRAINT billing_settlement_requests_non_negative_check CHECK (requested_actual_units >= 0 AND captured_units_total >= 0 AND released_units_total >= 0 AND unfunded_units >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- billing_settlement_exceptions：未结算用量与账务异常（D4）——本表行不产生任何钱包/ledger 变动；
-- reservation_attempt = 与异常直接关联的最后已持久化 attempt（v1.5：过期路径关联已过期 attempt，不引用未创建的目标）。
CREATE TABLE IF NOT EXISTS billing_settlement_exceptions (
  exception_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  reservation_attempt INT NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  exception_type VARCHAR(32) NOT NULL,
  actual_units INT NOT NULL DEFAULT 0,
  captured_units INT NOT NULL DEFAULT 0,
  unfunded_units INT NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(191) NOT NULL,
  reconciliation_status VARCHAR(16) NOT NULL DEFAULT 'open',
  resolution_reference VARCHAR(128) NULL,
  resolved_by VARCHAR(191) NULL,
  resolved_at DATETIME(3) NULL,
  resolution_reason VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY billing_settlement_exceptions_idempotency_unique (idempotency_key),
  UNIQUE KEY billing_settlement_exceptions_run_attempt_type_unique (run_id, reservation_attempt, exception_type),
  CONSTRAINT billing_settlement_exceptions_non_negative_check CHECK (actual_units >= 0 AND captured_units >= 0 AND unfunded_units >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- billing_reserve_requests：reserve 请求持久幂等身份（D13/D16/D18）——request_id 已存在 → 永远返回原结果
-- 绝不创建新 attempt；指纹（run_id + account_id + requested_units）不一致 → idempotency_conflict；
-- 并发唯一键冲突 → 整体回滚后全新事务重读收敛（D19，不复用旧 read view）。
CREATE TABLE IF NOT EXISTS billing_reserve_requests (
  request_id CHAR(36) NOT NULL PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  requested_units INT NOT NULL,
  reservation_attempt INT NOT NULL,
  allocation_snapshot JSON NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'reserved',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY billing_reserve_requests_run_idx (run_id),
  CONSTRAINT billing_reserve_requests_units_positive_check CHECK (requested_units > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
