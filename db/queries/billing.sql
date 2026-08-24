-- M1 计费闭环（设计 §4）：authorize/settle 闸门、TTL 扫尾、日对账。
-- 条件更新预扣是唯一的并发护栏：affected rows = 0 即该层不足。

-- name: GetOrgByID :one
SELECT * FROM orgs WHERE id = ? LIMIT 1;

-- name: GetMemberByID :one
SELECT * FROM members WHERE id = ? LIMIT 1;

-- 同一 org 下 active 且在有效期内的 License，先到期者优先（valid_to 升序）。
-- name: ListUsableLicenses :many
SELECT * FROM licenses
WHERE org_id = ? AND status = 'active' AND valid_from <= ? AND valid_to >= ?
ORDER BY valid_to ASC;

-- 某节点在某 License 当前周期的计数器行。无行 = 未设帽，天然跳过（不是错误）。
-- name: GetQuotaPool :one
SELECT * FROM quota_pools
WHERE node_type = ? AND node_id = ? AND license_id = ? AND capability = ?
  AND period_start <= ? AND period_end >= ?
LIMIT 1;

-- 条件更新预扣：used + estimated <= total 才命中。
-- name: ReserveQuota :execrows
UPDATE quota_pools SET used = used + ? WHERE id = ? AND used + ? <= total;

-- settle/退款/扫尾的无条件调平（行已被条件更新认领后才允许调）。
-- name: AdjustQuotaUsed :exec
UPDATE quota_pools SET used = used + ? WHERE id = ?;

-- name: InsertUsageRecord :exec
INSERT INTO usage_records
  (id, job_id, org_id, license_id, member_id, unit_id, project_id, capability, amount, unit, hit_pools, status)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved');

-- name: GetUsageRecordByJobID :one
SELECT * FROM usage_records WHERE job_id = ? LIMIT 1;

-- 认领成功结算：只允许 reserved → settled。rows = 0 说明已被扫尾/重复回调抢走。
-- name: ClaimSettled :execrows
UPDATE usage_records
SET status = 'settled', amount = ?, vendor_cost = ?, settled_at = NOW(3)
WHERE id = ? AND status = 'reserved';

-- 认领终态（refunded / expired）：只允许 reserved → 终态。
-- name: ClaimTerminal :execrows
UPDATE usage_records SET status = ? WHERE id = ? AND status = 'reserved';

-- name: ListExpiredReservations :many
SELECT * FROM usage_records
WHERE status = 'reserved' AND created_at < ?
ORDER BY created_at LIMIT ?;

-- name: InsertAuditLog :exec
INSERT INTO audit_logs (actor, action, target, after_json) VALUES (?, ?, ?, ?);

-- 日对账：只对根池（设计 §4：帽行不进对账）。
-- name: ListRootPools :many
SELECT * FROM quota_pools WHERE node_type = 'org' ORDER BY license_id, period_start;

-- name: SumSettledAmount :one
SELECT CAST(COALESCE(SUM(amount), 0) AS DOUBLE) FROM usage_records
WHERE license_id = ? AND capability = ? AND status = 'settled' AND created_at >= ? AND created_at < ?;

-- name: SumReservedAmount :one
SELECT CAST(COALESCE(SUM(amount), 0) AS DOUBLE) FROM usage_records
WHERE license_id = ? AND capability = ? AND status = 'reserved' AND created_at >= ? AND created_at < ?;
