-- 分析输出语言（产品级设置）：注册时选择、产品设置页可改；AI 产出的功能/场景/摘要/
-- 发布稿按此语言生成。工作区默认值供注册继承（对齐 migration 051 的触发模式先例）。
-- spec_versions 逐版记录语言：存量版本=中文；语言切换后首个 run 强制全量重建，
-- 渲染侧的确定性文案标签（变化动词、发布稿 kind 徽标）按版本语言取值。
ALTER TABLE products
  ADD COLUMN output_language VARCHAR(8) NOT NULL DEFAULT 'zh-CN';
ALTER TABLE organizations
  ADD COLUMN default_output_language VARCHAR(8) NOT NULL DEFAULT 'zh-CN';
ALTER TABLE spec_versions
  ADD COLUMN output_language VARCHAR(8) NOT NULL DEFAULT 'zh-CN';
