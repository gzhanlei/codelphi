-- 工作区级分析触发默认：新接入的仓库继承此设置（migration 050 的 per-repo 三列不变，
-- 仅对已有仓库的显式设置生效；注册路径读取本默认值写入新仓库行）。
ALTER TABLE organizations
  ADD COLUMN default_analysis_trigger VARCHAR(16) NOT NULL DEFAULT 'push',
  ADD COLUMN default_analysis_trigger_n INT UNSIGNED NULL,
  ADD COLUMN default_analysis_trigger_hour TINYINT UNSIGNED NULL;
