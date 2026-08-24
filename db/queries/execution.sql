-- M3 lesson 状态机（设计 §2.1、§7）：job/package/artifact/material 的读写。
-- 状态迁移一律条件 UPDATE（WHERE status = 期望前态），rows=0 即非法迁移或被并发抢走。

-- name: InsertJob :exec
INSERT INTO jobs (id, org_id, project_id, package_id, parent_id, kind, capability, platform, status)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: GetJob :one
SELECT * FROM jobs WHERE id = ? LIMIT 1;

-- name: ListStepJobs :many
SELECT * FROM jobs WHERE parent_id = ? ORDER BY created_at;

-- name: TransitionJob :execrows
UPDATE jobs SET status = ? WHERE id = ? AND status = ?;

-- 步骤失败诊断（error code / message）落 cost_report JSON。
-- name: SetJobCostReport :exec
UPDATE jobs SET cost_report = ? WHERE id = ?;

-- name: InsertCoursePackage :exec
INSERT INTO course_packages (id, project_id, status, lesson_job_id) VALUES (?, ?, ?, ?);

-- name: GetCoursePackage :one
SELECT * FROM course_packages WHERE id = ? LIMIT 1;

-- name: UpdatePackageStatus :exec
UPDATE course_packages SET status = ? WHERE id = ?;

-- name: GetProject :one
SELECT * FROM projects WHERE id = ? LIMIT 1;

-- name: ListProjectMaterials :many
SELECT * FROM materials WHERE project_id = ? ORDER BY created_at;

-- Artifact 留版本（设计 §3）：新版本行 + is_current 指针迁移，同事务。
-- name: NextArtifactVersion :one
SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE package_id = ? AND kind = ?;

-- name: ClearCurrentArtifact :exec
UPDATE artifacts SET is_current = 0 WHERE package_id = ? AND kind = ?;

-- name: InsertArtifact :exec
INSERT INTO artifacts (id, package_id, kind, version, status, step_job_id, storage_ref, is_current)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- name: ListCurrentArtifacts :many
SELECT * FROM artifacts WHERE package_id = ? AND is_current = 1;
