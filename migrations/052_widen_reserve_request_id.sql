-- 紧急修复（生产 2026-11-09 16:29 起 push 分析全量失败）：
-- webhook 入队 requestId = "push-" + deliveryId（36 字符 UUID）= 41 字符，
-- 超出 CHAR(36)，事务内预留镜像行 INSERT 报 ER_DATA_TOO_LONG → 全部 push 分析 failed_retryable。
-- 放宽到 VARCHAR(64)（CHAR→VARCHAR 同时避免尾部空格填充语义）。
ALTER TABLE billing_reserve_requests MODIFY request_id VARCHAR(64) NOT NULL;
ALTER TABLE billing_settlement_requests MODIFY request_id VARCHAR(64) NOT NULL;
