-- +goose Up
-- codelphi M0 初始 schema：实体与字段以设计文档 §3 为准，不增不减。
-- id 统一 CHAR(26) ULID，应用侧生成；金额 DECIMAL；引擎 InnoDB / utf8mb4。

CREATE TABLE orgs (
  id            CHAR(26)     NOT NULL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  status        ENUM('active','suspended') NOT NULL DEFAULT 'active',
  contact_name  VARCHAR(255) NULL,
  contact_email VARCHAR(255) NULL,
  contact_phone VARCHAR(64)  NULL,
  invoice_title VARCHAR(255) NULL COMMENT '发票抬头',
  tax_no        VARCHAR(64)  NULL COMMENT '税号',
  bank_info     VARCHAR(512) NULL COMMENT '银行信息',
  payer_name    VARCHAR(255) NULL COMMENT '付款单位，可与 name 不同',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE org_units (
  id              CHAR(26)     NOT NULL PRIMARY KEY,
  org_id          CHAR(26)     NOT NULL,
  parent_id       CHAR(26)     NULL COMMENT '自引用树，深度上限 4（应用层约束）',
  name            VARCHAR(255) NOT NULL,
  label           VARCHAR(255) NULL COMMENT '自由文本 preset 文案，不进 schema 语义',
  allocation_mode ENUM('over','strict') NOT NULL DEFAULT 'over',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_unit_org_parent (org_id, parent_id),
  CONSTRAINT fk_unit_org    FOREIGN KEY (org_id)    REFERENCES orgs(id),
  CONSTRAINT fk_unit_parent FOREIGN KEY (parent_id) REFERENCES org_units(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE members (
  id                CHAR(26)     NOT NULL PRIMARY KEY,
  org_id            CHAR(26)     NOT NULL,
  chandler_sub      VARCHAR(255) NOT NULL,
  role              ENUM('owner','admin','member','viewer') NOT NULL DEFAULT 'member',
  status            ENUM('invited','active','disabled') NOT NULL DEFAULT 'invited',
  invited_at        DATETIME(3)  NULL,
  invite_expires_at DATETIME(3)  NULL,
  disabled_at       DATETIME(3)  NULL,
  disabled_by       CHAR(26)     NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_member_org_sub (org_id, chandler_sub),
  CONSTRAINT fk_member_org FOREIGN KEY (org_id) REFERENCES orgs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE package_templates (
  id              CHAR(26)      NOT NULL PRIMARY KEY,
  name            VARCHAR(255)  NOT NULL,
  items           JSON          NOT NULL COMMENT '[{capability, quota, unit}]，quota 为内部护栏初值',
  years           TINYINT       NOT NULL COMMENT '年限 1/2/3',
  reference_price DECIMAL(12,2) NULL,
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE licenses (
  id              CHAR(26)      NOT NULL PRIMARY KEY,
  org_id          CHAR(26)      NOT NULL,
  contract_no     VARCHAR(128)  NOT NULL,
  valid_from      DATE          NOT NULL,
  valid_to        DATE          NOT NULL,
  status          ENUM('pending','active','expired','suspended') NOT NULL DEFAULT 'pending',
  payment_channel ENUM('offline','chandler') NOT NULL DEFAULT 'offline',
  paid_amount     DECIMAL(12,2) NULL COMMENT '实收金额',
  snapshot        JSON          NOT NULL COMMENT '套餐快照，不可变；变更 = 新 License/LicenseAmendment',
  created_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_license_contract (contract_no),
  KEY idx_license_org_status_valid (org_id, status, valid_to),
  CONSTRAINT fk_license_org FOREIGN KEY (org_id) REFERENCES orgs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 计数器只存在于两类行：Org 根池（每单必有）+ 被显式设帽的节点（稀疏存在）。
-- 服务闸门，不服务报表；报表一律从 usage_records 聚合。
CREATE TABLE quota_pools (
  id           CHAR(26)      NOT NULL PRIMARY KEY,
  node_type    ENUM('org','unit','member') NOT NULL,
  node_id      CHAR(26)      NOT NULL,
  license_id   CHAR(26)      NOT NULL,
  capability   VARCHAR(64)   NOT NULL,
  unit         ENUM('count','second','minute') NOT NULL DEFAULT 'count',
  total        DECIMAL(14,3) NOT NULL,
  used         DECIMAL(14,3) NOT NULL DEFAULT 0,
  period_start DATE          NOT NULL COMMENT '按授权年分条，高校对齐学年（9 月）',
  period_end   DATE          NOT NULL,
  created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_pool (node_type, node_id, license_id, capability, period_start),
  CONSTRAINT fk_pool_license FOREIGN KEY (license_id) REFERENCES licenses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE projects (
  id              CHAR(26)     NOT NULL PRIMARY KEY,
  org_id          CHAR(26)     NOT NULL,
  unit_id         CHAR(26)     NULL,
  owner_member_id CHAR(26)     NOT NULL,
  type_label      VARCHAR(64)  NULL,
  title           VARCHAR(255) NOT NULL COMMENT '章名，如「高等数学 · 第 3 章 导数」',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_project_org (org_id),
  CONSTRAINT fk_project_org    FOREIGN KEY (org_id)          REFERENCES orgs(id),
  CONSTRAINT fk_project_unit   FOREIGN KEY (unit_id)         REFERENCES org_units(id),
  CONSTRAINT fk_project_member FOREIGN KEY (owner_member_id) REFERENCES members(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE materials (
  id          CHAR(26)     NOT NULL PRIMARY KEY,
  project_id  CHAR(26)     NOT NULL,
  kind        ENUM('pdf','docx','image','text') NOT NULL,
  storage_ref VARCHAR(512) NOT NULL COMMENT '对象存储 key，org 前缀',
  uploaded_by CHAR(26)     NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_material_project (project_id),
  CONSTRAINT fk_material_project FOREIGN KEY (project_id)  REFERENCES projects(id),
  CONSTRAINT fk_material_member  FOREIGN KEY (uploaded_by) REFERENCES members(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE course_packages (
  id            CHAR(26)    NOT NULL PRIMARY KEY,
  project_id    CHAR(26)    NOT NULL,
  status        ENUM('draft','building','ready','partial') NOT NULL DEFAULT 'draft',
  lesson_job_id CHAR(26)    NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_package_project (project_id),
  CONSTRAINT fk_package_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 两层 job：lesson 下面挂 step（parent_id）。权威状态机在网关（设计 §7）。
CREATE TABLE jobs (
  id              CHAR(26)     NOT NULL PRIMARY KEY,
  org_id          CHAR(26)     NOT NULL,
  project_id      CHAR(26)     NOT NULL,
  package_id      CHAR(26)     NULL,
  parent_id       CHAR(26)     NULL COMMENT 'step → lesson',
  kind            ENUM('lesson','step') NOT NULL,
  capability      VARCHAR(64)  NULL COMMENT 'step 必带：design|outline|ppt|...',
  platform        VARCHAR(64)  NULL COMMENT '执行引擎，如 pptcreator',
  platform_job_id VARCHAR(255) NULL,
  status          ENUM('queued','running','awaiting_confirm','succeeded','failed','canceled','expired') NOT NULL DEFAULT 'queued',
  spec_ref        VARCHAR(512) NULL,
  cost_report     JSON         NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_job_org_status (org_id, status),
  KEY idx_job_parent (parent_id),
  CONSTRAINT fk_job_org     FOREIGN KEY (org_id)     REFERENCES orgs(id),
  CONSTRAINT fk_job_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_job_parent  FOREIGN KEY (parent_id)  REFERENCES jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Artifact 留版本：每次重建产生新版本行，is_current 指向最新。
CREATE TABLE artifacts (
  id          CHAR(26)    NOT NULL PRIMARY KEY,
  package_id  CHAR(26)    NOT NULL,
  kind        ENUM('design','outline','ppt','script','exercise','lecture_video','asset_3d') NOT NULL,
  version     INT         NOT NULL,
  status      ENUM('building','ready','failed') NOT NULL DEFAULT 'building',
  step_job_id CHAR(26)    NULL,
  storage_ref VARCHAR(512) NULL,
  is_current  TINYINT(1)  NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_artifact_version (package_id, kind, version),
  KEY idx_artifact_current (package_id, kind, is_current),
  CONSTRAINT fk_artifact_package FOREIGN KEY (package_id)  REFERENCES course_packages(id),
  CONSTRAINT fk_artifact_job     FOREIGN KEY (step_job_id) REFERENCES jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 只增台账，一切报表的数据源。一次尝试一个 job_id：重试 = 新 job、新预扣。
CREATE TABLE usage_records (
  id          CHAR(26)      NOT NULL PRIMARY KEY,
  job_id      CHAR(26)      NOT NULL COMMENT '幂等键',
  org_id      CHAR(26)      NOT NULL,
  license_id  CHAR(26)      NOT NULL,
  member_id   CHAR(26)      NOT NULL,
  unit_id     CHAR(26)      NULL,
  project_id  CHAR(26)      NULL,
  capability  VARCHAR(64)   NOT NULL,
  amount      DECIMAL(14,3) NOT NULL COMMENT '内部计量（护栏分母）',
  unit        ENUM('count','second','minute') NOT NULL DEFAULT 'count',
  vendor      VARCHAR(64)   NULL,
  vendor_cost DECIMAL(14,6) NULL COMMENT '己方成本（毛利依据）',
  status      ENUM('reserved','settled','refunded','expired') NOT NULL DEFAULT 'reserved',
  created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  settled_at  DATETIME(3)   NULL,
  UNIQUE KEY uq_usage_job (job_id),
  KEY idx_usage_org_cap_status (org_id, capability, status),
  KEY idx_usage_member (member_id),
  KEY idx_usage_license (license_id),
  CONSTRAINT fk_usage_org     FOREIGN KEY (org_id)     REFERENCES orgs(id),
  CONSTRAINT fk_usage_license FOREIGN KEY (license_id) REFERENCES licenses(id),
  CONSTRAINT fk_usage_member  FOREIGN KEY (member_id)  REFERENCES members(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 只增审计。License 状态变更、改帽、停用成员、partner 调用、authorize 拒绝，全部落库。
CREATE TABLE audit_logs (
  id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor      VARCHAR(255) NOT NULL,
  action     VARCHAR(128) NOT NULL,
  target     VARCHAR(255) NOT NULL,
  before_json JSON        NULL,
  after_json  JSON        NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_target (target),
  KEY idx_audit_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +goose Down
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS usage_records;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS course_packages;
DROP TABLE IF EXISTS materials;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS quota_pools;
DROP TABLE IF EXISTS licenses;
DROP TABLE IF EXISTS package_templates;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS org_units;
DROP TABLE IF EXISTS orgs;
