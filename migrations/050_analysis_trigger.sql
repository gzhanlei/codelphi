-- 按仓库的分析触发模式（定价校准：1 push = 1 SAU 的固定粒度让高频直推用户必然超额）：
--   push        每次默认分支 push 立即分析（现状）；
--   daily       每天低峰期（analysis_trigger_hour，默认凌晨 3 点）至多一次，当天有 push 才分析；
--   push_count  每 N 次 push 立即分析（analysis_trigger_n），并由 daily sweep 当天兜底一次。
-- pending_push_count 记录自上次分析以来的未处理 push 数（webhook 递增，触发/兜底后归零）。
ALTER TABLE repositories
  ADD COLUMN analysis_trigger VARCHAR(16) NOT NULL DEFAULT 'push',
  ADD COLUMN analysis_trigger_n INT UNSIGNED NULL,
  ADD COLUMN analysis_trigger_hour TINYINT UNSIGNED NULL,
  ADD COLUMN pending_push_count INT UNSIGNED NOT NULL DEFAULT 0;
