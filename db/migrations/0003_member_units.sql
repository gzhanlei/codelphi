-- +goose Up
-- M1 身份链：Member ↔ OrgUnit 的 M:N 关系表（设计 §3「schema 保留 M:N，P0 每人只挂一个 unit」，
-- §13 B.4 假定此表存在）。identity.Resolver 的 X-Unit-Id 归属校验依赖它。
-- 刻意不加 role 列（§13 B.4：不为全校统签预埋角色系统）。

CREATE TABLE member_units (
  member_id  CHAR(26)    NOT NULL,
  unit_id    CHAR(26)    NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (member_id, unit_id),
  KEY idx_mu_unit (unit_id),
  CONSTRAINT fk_mu_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_mu_unit   FOREIGN KEY (unit_id)   REFERENCES org_units(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +goose Down
DROP TABLE IF EXISTS member_units;
