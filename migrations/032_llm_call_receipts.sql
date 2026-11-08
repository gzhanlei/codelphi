-- LLM 调用级成本回执（M0-T2，契约：每次 provider request 即时写一条，成功/失败/超时各记）。
-- usage_status：known（拿到 usage）/ unknown（超时/失败未拿到，禁止假设零成本）。
-- pricing_status：priced（单价已配置，成本可算）/ unpriced（未配置，成本 NULL——零成本与未知成本是两种状态）。
-- 单价随行快照（pricing_version + 四项单价）：供应商调价后历史成本仍可复核。
CREATE TABLE IF NOT EXISTS llm_call_receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT UNSIGNED NOT NULL,
  account_id BIGINT UNSIGNED NULL,
  charge_component VARCHAR(16) NOT NULL DEFAULT 'main',
  model VARCHAR(64) NOT NULL,
  provider_request_id VARCHAR(191) NULL,
  outcome VARCHAR(16) NOT NULL,
  usage_status VARCHAR(16) NOT NULL,
  input_tokens INT NULL,
  output_tokens INT NULL,
  cache_hit_tokens INT NULL,
  cache_miss_tokens INT NULL,
  usage_json TEXT NULL,
  pricing_version VARCHAR(32) NULL,
  input_price DECIMAL(12,6) NULL,
  output_price DECIMAL(12,6) NULL,
  cache_price DECIMAL(12,6) NULL,
  currency CHAR(8) NOT NULL DEFAULT 'CNY',
  llm_cost_amount DECIMAL(12,6) NULL,
  pricing_status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY llm_call_receipts_run_idx (run_id),
  KEY llm_call_receipts_account_created_idx (account_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
