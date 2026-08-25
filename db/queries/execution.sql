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
INSERT INTO course_packages (id, project_id, lesson_id, preset_id, status, lesson_job_id) VALUES (?, ?, ?, ?, ?, ?);

-- name: GetCoursePackage :one
SELECT * FROM course_packages WHERE id = ? LIMIT 1;

-- name: LockCoursePackage :one
SELECT * FROM course_packages WHERE id = ? FOR UPDATE;

-- name: UpdatePackageStatus :exec
UPDATE course_packages SET status = ? WHERE id = ?;

-- name: GetProject :one
SELECT * FROM projects WHERE id = ? LIMIT 1;

-- name: ListProjectMaterials :many
SELECT * FROM materials WHERE project_id = ? ORDER BY created_at;

-- name: ListLessonMaterials :many
SELECT * FROM materials WHERE lesson_id = ? ORDER BY created_at;

-- name: CountLessonMaterials :one
SELECT COUNT(*) FROM materials WHERE lesson_id = ?;

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

-- name: ListArtifactsByPackage :many
SELECT * FROM artifacts WHERE package_id = ? ORDER BY kind ASC, version DESC;

-- name: InsertProject :exec
INSERT INTO projects (id, org_id, unit_id, owner_member_id, title, preset_id) VALUES (?, ?, ?, ?, ?, ?);

-- name: ListProjectsByOrg :many
SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC;

-- name: ListProjectsByOwner :many
SELECT * FROM projects WHERE org_id = ? AND owner_member_id = ? ORDER BY created_at DESC;

-- name: InsertCourseLesson :exec
INSERT INTO course_lessons (id, project_id, title) VALUES (?, ?, ?);

-- name: GetCourseLesson :one
SELECT * FROM course_lessons WHERE id = ? LIMIT 1;

-- name: LockCourseLesson :one
SELECT * FROM course_lessons WHERE id = ? FOR UPDATE;

-- name: ListCourseLessonsByProject :many
SELECT * FROM course_lessons WHERE project_id = ? ORDER BY created_at;

-- name: InsertMaterial :exec
INSERT INTO materials (id, project_id, lesson_id, kind, filename, storage_ref, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: GetLatestPackageByProject :one
SELECT * FROM course_packages WHERE project_id = ? ORDER BY created_at DESC LIMIT 1;

-- name: GetLatestPackageByLesson :one
SELECT * FROM course_packages WHERE lesson_id = ? ORDER BY created_at DESC LIMIT 1;

-- name: GetInFlightLessonByProject :one
SELECT * FROM jobs
WHERE project_id = ? AND kind = 'lesson' AND status IN ('queued', 'running', 'awaiting_confirm')
ORDER BY created_at DESC LIMIT 1;

-- name: GetInFlightLessonByCourseLesson :one
SELECT j.*
FROM jobs j
INNER JOIN course_packages p ON p.lesson_job_id = j.id
WHERE p.lesson_id = ? AND j.kind = 'lesson' AND j.status IN ('queued', 'running', 'awaiting_confirm')
ORDER BY j.created_at DESC
LIMIT 1;

-- 重启恢复/超时收敛：queued 与 running 都可能是上一进程残留。
-- name: AbortJob :execrows
UPDATE jobs SET status = 'failed', cost_report = ? WHERE id = ? AND status IN ('queued', 'running');

-- name: ListJobsByStatuses :many
SELECT * FROM jobs WHERE status IN (?, ?);

-- name: ListStaleRunningJobs :many
SELECT * FROM jobs WHERE status = 'running' AND updated_at < ?;

-- name: PartialPackageByLesson :exec
UPDATE course_packages SET status = 'partial' WHERE lesson_job_id = ?;
