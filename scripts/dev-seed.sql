-- 本地联调夹具。生产库禁止执行。
-- 网关：CODELPHI_DEV_AUTH_SUB=dev-local
-- 工作台：DEV_AUTH=1

INSERT INTO orgs (id, name, status)
VALUES ('01JDEVORG00000000000000001', '本地联调机构', 'active')
ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'active';

INSERT INTO members (id, org_id, chandler_sub, role, status)
VALUES ('01JDEVMEM00000000000000001', '01JDEVORG00000000000000001', 'dev-local', 'owner', 'active')
ON DUPLICATE KEY UPDATE role = 'owner', status = 'active';

INSERT INTO licenses (id, org_id, contract_no, valid_from, valid_to, status, snapshot, presets)
VALUES (
  '01JDEVLIC00000000000000001',
  '01JDEVORG00000000000000001',
  'DEV-LOCAL',
  DATE_SUB(CURDATE(), INTERVAL 1 DAY),
  DATE_ADD(CURDATE(), INTERVAL 1 YEAR),
  'active',
  JSON_ARRAY(
    JSON_OBJECT('capability', 'ppt', 'quota', 1000, 'unit', 'count')
  ),
  JSON_ARRAY('digital_lesson')
)
ON DUPLICATE KEY UPDATE status = 'active';

INSERT INTO quota_pools (id, node_type, node_id, license_id, capability, unit, total, used, period_start, period_end)
VALUES (
  '01JDEVPOOLPPT0000000000001',
  'org',
  '01JDEVORG00000000000000001',
  '01JDEVLIC00000000000000001',
  'ppt',
  'count',
  1000,
  0,
  DATE_SUB(CURDATE(), INTERVAL 1 DAY),
  DATE_ADD(CURDATE(), INTERVAL 1 YEAR)
)
ON DUPLICATE KEY UPDATE total = 1000, period_end = VALUES(period_end);
