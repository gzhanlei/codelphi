-- M9 放量（2026-11-07 产品决策）：影子门槛上线后（0f89da0 + bef186b），增量模式
-- 在 dogfooding 产品过门槛（referenceConsistency 0.787 ≥ 0.70，功能集 100% 一致），
-- 全量 vs 全量噪声底实测 0.80。全库切换为默认增量；安全性由保守回退链保证：
-- 无上一版规格（新产品首次分析）→ 全量建基线；diff > 200 文件或受影响占比 > 60% → 全量。
UPDATE products SET analyze_mode = 'incremental' WHERE analyze_mode = 'full';

ALTER TABLE products ALTER COLUMN analyze_mode SET DEFAULT 'incremental';
