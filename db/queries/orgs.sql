-- name: CreateOrg :exec
INSERT INTO orgs (id, name) VALUES (?, ?);

-- name: GetOrg :one
SELECT * FROM orgs WHERE id = ? LIMIT 1;

-- name: GetMemberBySub :one
SELECT * FROM members WHERE org_id = ? AND chandler_sub = ? LIMIT 1;
