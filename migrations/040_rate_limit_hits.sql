-- 导出限流计数（契约 M1-T5/§10.4）：固定窗口；rl_key = HMAC-SHA256(服务端密钥, "kind:identity")，
-- 不存原始 IP/userId（裸哈希可被低熵反查）；key 域前缀（ip:/user:）在 HMAC 输入中区分。
-- 窗口推进由锁内绝对值计算完成（契约 P1-5：不依赖 ODKU 求值顺序）；过期行由每日对账清理。
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  rl_key CHAR(64) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  window_start DATETIME(3) NOT NULL,
  count INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY rate_limit_hits_window_idx (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
