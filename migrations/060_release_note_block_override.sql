-- Release notes 真块级校对（GTM 桥面批次 1）：块正文人工改写落库。
-- summary_override 为空 = 公开页与面板渲染 spec_changes 现值（原文不被复制、随规格走）；
-- 非空 = 人工校对后的措辞覆盖展示。锚定与证据校验语义不变（lib/release-notes.ts validateDraft）。
ALTER TABLE release_note_blocks
  ADD COLUMN summary_override TEXT NULL AFTER emphasis;
