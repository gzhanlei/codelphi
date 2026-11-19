-- BYO 快照导入（设计 2026-11-18-radar-import-byo §P0-7a，2026-11-19）：
-- 1) mcp_api_keys 增加 scope：存量 key 默认 'mcp_read'（语义与现状完全一致，零回归）；
--    'snapshot_write' 允许调用导入端点（含读取自身组织产品所需的最小查询）。
-- 2) products 增加 seeded 基线（导入草稿的三级匹配锚，见 §5.3）。
ALTER TABLE mcp_api_keys
  ADD COLUMN scope VARCHAR(32) NOT NULL DEFAULT 'mcp_read' AFTER key_hint;

-- 导入草稿来源标记 'ai_snapshot_import'（17 字符）超出 VARCHAR(16)，加宽到 32（存量值不变）。
ALTER TABLE features
  MODIFY COLUMN source VARCHAR(32) NOT NULL DEFAULT 'generated';
ALTER TABLE scenarios
  MODIFY COLUMN source VARCHAR(32) NOT NULL DEFAULT 'generated';

ALTER TABLE products
  ADD COLUMN seeded_snapshot_sha CHAR(64) NULL AFTER analyze_mode,
  ADD COLUMN seeded_tree_sha CHAR(64) NULL AFTER seeded_snapshot_sha,
  ADD COLUMN seeded_dirty TINYINT(1) NOT NULL DEFAULT 0 AFTER seeded_tree_sha,
  ADD COLUMN seeded_contract_version VARCHAR(32) NULL AFTER seeded_dirty,
  ADD COLUMN seeded_at DATETIME(3) NULL AFTER seeded_contract_version;
