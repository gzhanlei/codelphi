-- M1 身份链（设计 §5）：sub → member/org/unit 解析。

-- name: ListMembershipsBySub :many
SELECT * FROM members WHERE chandler_sub = ?;

-- name: GetMembershipBySubOrg :one
SELECT * FROM members WHERE chandler_sub = ? AND org_id = ? LIMIT 1;

-- 成员归属的 unit 列表（P0 每人只挂一个 unit，M:N schema 预留）。
-- name: ListMemberUnits :many
SELECT u.* FROM member_units mu
JOIN org_units u ON u.id = mu.unit_id
WHERE mu.member_id = ?;

-- 工作台 org 选择器：/v1/me 不走 Resolve（多归属时 Resolve 会 org_unspecified）。
-- name: ListMembershipsWithOrgBySub :many
SELECT m.id, m.org_id, m.chandler_sub, m.role, m.status, o.name AS org_name
FROM members m
JOIN orgs o ON o.id = m.org_id
WHERE m.chandler_sub = ?;
