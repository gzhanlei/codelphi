-- A1 MCP OAuth PKCE 连接流（docs/specsight-gap-improvement-plan.md §4.1）：
-- 外部 AI 助手（Claude / ChatGPT 网页端）经授权码 + PKCE 换取访问 token。
-- 授权码与 token 都只存 SHA-256 哈希；token 1 小时过期（续期即重换）；
-- 30 天未使用需重连（last_used_at 判定）；批准信息（client_name / redirect_uri）留审计。
CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  client_name VARCHAR(191) NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_hash CHAR(64) NULL,
  code_challenge VARCHAR(128) NOT NULL,
  code_challenge_method VARCHAR(16) NOT NULL DEFAULT 'S256',
  token_hash CHAR(64) NULL,
  code_expires_at DATETIME(3) NULL,
  token_expires_at DATETIME(3) NULL,
  approved_at DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY mcp_oauth_grants_code_idx (code_hash),
  KEY mcp_oauth_grants_token_idx (token_hash),
  KEY mcp_oauth_grants_org_idx (organization_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
