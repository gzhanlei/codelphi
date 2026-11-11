-- 发布稿功能级成文 + 导语改写（用户反馈 2026-11-12：公开页把同功能的近似重复变化逐条
-- 罗列成墙，且导语是仓库技术语言）。改写单位从块改为功能：
-- feature_copy_json = [{feature, section, text}]（每功能一条用户可读说明，重复合并）；
-- lead_override = 发布级导语的改写（原文 release.summary 是维护者视角）。
ALTER TABLE release_notes
  ADD COLUMN lead_override TEXT NULL AFTER emphasis,
  ADD COLUMN feature_copy_json JSON NULL AFTER lead_override;
