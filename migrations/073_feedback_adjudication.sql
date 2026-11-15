-- Feedback AI 自动裁决管线（073）：
-- kind 列把 MCP send_feedback 的 [mcp:kind] 文本前缀升为结构化列（回填）；
-- verdict/verdict_reason/adjudicated_at 记录 AI 裁决结果（confirmed_defect=确认缺陷
-- 并触发修复性重建 / false_alarm=误报驳回 / needs_human=证据不足转人工）；
-- corrective_run_id 留痕裁决触发的修复性全量重建 run（标准 run，继承全部护栏）。
ALTER TABLE feedback_reports
  ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'bug',
  ADD COLUMN verdict VARCHAR(24) NULL,
  ADD COLUMN verdict_reason TEXT NULL,
  ADD COLUMN adjudicated_at DATETIME(3) NULL,
  ADD COLUMN corrective_run_id BIGINT UNSIGNED NULL;

-- 回填：MCP 路径的 kind 以 [mcp:bug] 前缀拼在 error_message 里
UPDATE feedback_reports SET kind = 'bug'
  WHERE error_message LIKE '[mcp:bug]%';
UPDATE feedback_reports SET kind = 'question'
  WHERE error_message LIKE '[mcp:question]%' AND kind = 'bug';
UPDATE feedback_reports SET kind = 'suggestion'
  WHERE error_message LIKE '[mcp:suggestion]%' AND kind = 'bug';
