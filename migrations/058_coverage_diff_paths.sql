-- W0-9 评审采纳（外部评审 2026-11-10）：diff 必选 ≠ diff 全覆盖——覆盖率回执增加
-- diff 面自身的入选/遗漏计数，让「优先选择」与「实际覆盖」可区分、可告警。
ALTER TABLE analysis_coverage_receipts
  ADD COLUMN diff_total_paths INT UNSIGNED NULL,
  ADD COLUMN diff_selected_paths INT UNSIGNED NULL,
  ADD COLUMN diff_omitted_paths INT UNSIGNED NULL;
