-- P0 措辞降噪的历史回填：给历史 spec_changes 行打 wording_only 标记。
-- 自 db935cb（P0）起，新分析在 diff 阶段就折叠仅措辞差异，不再产生这类行；
-- 本标记让历史行在进展摘要计数、能力聚合、发布变化列表与回归清单中被排除，
-- 使「行为变化」总数与降噪后的口径一致（回填脚本 scripts/backfill-wording-only.ts）。
-- 只标记不删除：regression_tasks 对 spec_changes 有 ON DELETE CASCADE 外键，
-- 删除行会级联清掉历史回归清单，破坏 QA 对已执行清单的对照。
ALTER TABLE spec_changes
  ADD COLUMN wording_only TINYINT(1) NOT NULL DEFAULT 0;
