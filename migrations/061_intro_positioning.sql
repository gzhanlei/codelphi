-- 介绍材料·定位块（GTM 桥面批次 2）：受众 / 差异化 / 语气是产品负责人的人工主张，
-- AI 生成时只能逐字引用、不得扩写为事实。仿 description 的 source 语义（migration 014）：
-- positioning_source 恒为 'manual'（分析管线不写此列），列存在是为未来演进预留。
ALTER TABLE products
  ADD COLUMN positioning_json JSON NULL AFTER description_evidence,
  ADD COLUMN positioning_source VARCHAR(16) NOT NULL DEFAULT 'manual' AFTER positioning_json;
