-- +goose Up
-- 项目 = 一套课程；一课是项目内单元。材料挂在课上（最多 5 份），不再把项目当成单课。
-- 已有项目各生成一课（id 暂用项目 id，仅迁移存量 1:1）。

CREATE TABLE course_lessons (
  id         CHAR(26)     NOT NULL PRIMARY KEY,
  project_id CHAR(26)     NOT NULL,
  title      VARCHAR(255) NOT NULL COMMENT '课名，如「第 3 章 导数」',
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_course_lesson_project (project_id),
  CONSTRAINT fk_course_lesson_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO course_lessons (id, project_id, title, created_at)
SELECT id, id, title, created_at FROM projects;

ALTER TABLE materials
  ADD COLUMN lesson_id CHAR(26) NULL AFTER project_id,
  ADD COLUMN filename VARCHAR(255) NULL AFTER kind;

UPDATE materials SET lesson_id = project_id WHERE lesson_id IS NULL;

ALTER TABLE materials
  MODIFY COLUMN lesson_id CHAR(26) NOT NULL,
  ADD KEY idx_material_lesson (lesson_id),
  ADD CONSTRAINT fk_material_lesson FOREIGN KEY (lesson_id) REFERENCES course_lessons(id);

ALTER TABLE course_packages
  ADD COLUMN lesson_id CHAR(26) NULL AFTER project_id;

UPDATE course_packages SET lesson_id = project_id WHERE lesson_id IS NULL;

ALTER TABLE course_packages
  MODIFY COLUMN lesson_id CHAR(26) NOT NULL,
  ADD KEY idx_package_lesson (lesson_id),
  ADD CONSTRAINT fk_package_lesson FOREIGN KEY (lesson_id) REFERENCES course_lessons(id);

-- +goose Down
ALTER TABLE course_packages DROP FOREIGN KEY fk_package_lesson;
ALTER TABLE course_packages DROP INDEX idx_package_lesson;
ALTER TABLE course_packages DROP COLUMN lesson_id;

ALTER TABLE materials DROP FOREIGN KEY fk_material_lesson;
ALTER TABLE materials DROP INDEX idx_material_lesson;
ALTER TABLE materials DROP COLUMN lesson_id;
ALTER TABLE materials DROP COLUMN filename;

DROP TABLE course_lessons;
