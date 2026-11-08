-- 用户风控标记（契约 M1-T4）：仅作早期预留字段；完整风控状态/审计后续独立建表，
-- 本列不承担任何账务语义（反滥用的核心约束在 trial_grants 唯一性）。
ALTER TABLE users ADD COLUMN risk_flags VARCHAR(255) NULL;
