-- Chandler 用户 token 持久化（M3-T1，契约 §7.0/P7）：支付 prepay 与查单需要有效用户 token，
-- 现有登录只存自签 JWT session——本表加密落库 access/refresh token 并支持自动刷新。
-- 密文 AES-256-GCM（keyring 版本化，TOKEN_ENCRYPTION_KEYS）；user_id 主键（一用户一份活 token）。
CREATE TABLE IF NOT EXISTS chandler_tokens (
  user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  access_token VARBINARY(2048) NOT NULL,
  refresh_token VARBINARY(2048) NULL,
  key_version VARCHAR(8) NOT NULL,
  token_expires_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chandler_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
