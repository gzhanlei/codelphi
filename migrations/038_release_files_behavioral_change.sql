-- 盲评修复方向 2（残余闭合）：记录每个变更文件在本发布中是否包含行为性行变更
-- （注释/空白以外的增删行）。分析时由 lib/patch-scan.ts 从 patch 确定性判定；
-- 渲染期折叠重算（loadFoldedChanges）与 spec_changes 门禁共用该标志。
-- 历史行默认 1（行为变更）——无 patch 佐证时保守处理，不追溯折叠。
ALTER TABLE release_files
  ADD COLUMN behavioral_change TINYINT(1) NOT NULL DEFAULT 1 COMMENT '本发布中该文件是否包含行为性行变更（非注释/空白增删行）；0=仅注释或空白变动';
