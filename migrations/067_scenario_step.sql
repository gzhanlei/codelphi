-- W-DECISION 最小序列版（docs/w-decision-scenario-sequence-plan.md §3）：
-- 场景步骤序号——happy 主链 1..N / edge-error 分支归属步骤；NULL=未标注（保持扇出形态）。
-- 判定面裁决：step_order 不参与行为变更判定，仅呈现与账本记录。
ALTER TABLE spec_scenarios ADD COLUMN step_order INT NULL;
ALTER TABLE scenarios ADD COLUMN step_order INT NULL;
