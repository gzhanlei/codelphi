-- +goose Up
-- M5b：License 卖预设包；Project/CoursePackage 绑 preset_id；artifacts.kind 改为 VARCHAR 以便第二包。
-- 空/NULL licenses.presets 由应用视为 ["digital_lesson"]，不改 snapshot 能力数组。

ALTER TABLE licenses
  ADD COLUMN presets JSON NULL COMMENT '授权的预设包 id 数组，与 snapshot 能力分开' AFTER snapshot;

ALTER TABLE projects
  ADD COLUMN preset_id VARCHAR(64) NOT NULL DEFAULT 'digital_lesson' AFTER type_label;

ALTER TABLE course_packages
  ADD COLUMN preset_id VARCHAR(64) NOT NULL DEFAULT 'digital_lesson' AFTER project_id;

ALTER TABLE artifacts
  MODIFY COLUMN kind VARCHAR(64) NOT NULL;

-- +goose Down
ALTER TABLE artifacts
  MODIFY COLUMN kind ENUM('design','outline','ppt','script','exercise','lecture_video','asset_3d') NOT NULL;

ALTER TABLE course_packages DROP COLUMN preset_id;
ALTER TABLE projects DROP COLUMN preset_id;
ALTER TABLE licenses DROP COLUMN presets;
