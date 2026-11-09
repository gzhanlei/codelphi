-- A1 MCP server（docs/specsight-gap-improvement-plan.md §4.1）：
-- 组织级只读 API key。仅存 SHA-256 哈希 + sk_cd_ 前缀 + 前 8 位可识别片段，
-- 明文只在创建时返回一次；软撤销保留审计（revoke_at），成员离职即失效。
CREATE TABLE IF NOT EXISTS mcp_api_keys (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(191) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  key_prefix VARCHAR(8) NOT NULL,
  key_hint VARCHAR(12) NOT NULL,
  created_by VARCHAR(191) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  UNIQUE KEY mcp_api_keys_hash_unique (key_hash),
  KEY mcp_api_keys_org_idx (organization_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
