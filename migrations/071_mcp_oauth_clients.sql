-- MCP OAuth 自动发现（RFC 8414 / 9728 / 7591）配套：
-- client_id 非机密（PKCE 公共客户端，真正闸门是授权页人工批准 + redirect_uri 精确匹配），明文存储；
-- grants 加 refresh_token 双 token 支持：access 1h + refresh 30 天旋转，哈希落库约定与 code/token 一致。
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id VARCHAR(64) NOT NULL,
  client_name VARCHAR(191) NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY mcp_oauth_clients_id_unique (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE mcp_oauth_grants
  ADD COLUMN client_id VARCHAR(64) NULL AFTER client_name,
  ADD COLUMN refresh_hash CHAR(64) NULL AFTER token_hash,
  ADD COLUMN refresh_expires_at DATETIME(3) NULL AFTER refresh_hash,
  ADD KEY mcp_oauth_grants_refresh_idx (refresh_hash);
