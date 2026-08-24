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
