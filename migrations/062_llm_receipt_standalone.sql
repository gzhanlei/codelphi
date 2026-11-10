-- 独立生成调用的成本回执（GTM 桥面批次 2）：介绍材料等一次性 AI 生成没有 analysis_runs
-- 语义，run_id 放开为可空，新增 call_kind 标注调用类别（如 'intro_material'）。
-- 记账口径（用户裁决 2026-11-11）：免费 + 如实记账——只写 receipt 不扣 SAU，定价页开放时再定。
ALTER TABLE llm_call_receipts
  MODIFY run_id BIGINT UNSIGNED NULL,
  ADD COLUMN call_kind VARCHAR(32) NULL AFTER charge_component;
