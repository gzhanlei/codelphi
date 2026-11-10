-- 规格编辑归因（P2 知识健康的数据基础，基线文档明确「不得通过推断补齐」）：
-- features/scenarios 记录最后一次人工编辑者（chandler_sub 字符串身份，非 FK——sub 不在
-- 本库 users 表之外还有 Chandler 侧语义）与时间。自动分析不写这两列（manual 保护语义不变），
-- 软删除同样落归因（删除也是一次维护动作，供维护分布统计）。
ALTER TABLE features
  ADD COLUMN last_edited_by VARCHAR(191) NULL,
  ADD COLUMN last_edited_at DATETIME(3) NULL;
ALTER TABLE scenarios
  ADD COLUMN last_edited_by VARCHAR(191) NULL,
  ADD COLUMN last_edited_at DATETIME(3) NULL;
