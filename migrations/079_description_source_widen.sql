-- BYO 导入草稿来源标记 'ai_snapshot_import'（17 字符）超出 products.description_source
-- 的 VARCHAR(16)（2026-11-19 实测 ER_DATA_TOO_LONG）；加宽到 32，与 features/scenarios
-- 的 078 加宽同口径。存量值（generated/manual）不变。
ALTER TABLE products
  MODIFY COLUMN description_source VARCHAR(32) NOT NULL DEFAULT 'manual';
