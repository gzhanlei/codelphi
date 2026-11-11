-- 发布稿合成标题（用户裁决：Specsight 形态对齐）——发布稿是成文公告：
-- H1 = AI 撰写的一句话公告标题（人工可改），不再是 git commit 信息。
-- 条目保持块级（Specsight 同为 per-behavior 粒度），文案经 AI 改写为用户影响语言。
ALTER TABLE release_notes
  ADD COLUMN headline VARCHAR(400) NULL AFTER emphasis;
