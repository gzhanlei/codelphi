-- A3 Highlight 九类分类（docs/specsight-gap-improvement-plan.md §4.2）：
-- spec_changes 增加 highlight_type / highlight_reason 两列。分类为确定性规则
-- （lib/spec-highlights.ts），零 AI 成本；绝大多数 change 不打标（NULL），
-- 不为填满而强标。发布页 / A2 Digest / A1 MCP changelog 按这两列筛选与排序。
ALTER TABLE spec_changes
  ADD COLUMN highlight_type VARCHAR(32) NULL AFTER summary,
  ADD COLUMN highlight_reason VARCHAR(500) NULL AFTER highlight_type,
  ADD KEY spec_changes_highlight_idx (spec_version_id, highlight_type);
