-- 身份层（规格《客户端增量分析与 Delta Merge Contract 设计》§9.2、§20）。
-- 功能与场景的身份键和名称键分开存放。名称键是当版的键，身份键跨版本稳定。
-- 功能身份键取首次出现时的名称键，场景身份键是（所属功能身份，编号），编号是场景的 reference。
--
-- 只做加法：既有表只在末尾追加可空列。部署时迁移先于新应用运行，旧应用忽略这些列照常服务，
-- 回滚只回滚镜像。回填之前身份列全部为空，读取路径遇到空值按失败关闭处理，不按名称临时推断。
--
-- 身份列一律用 utf8mb4_bin。现有的名称列不区分大小写和重音，身份比较必须和应用层的名称键规则
-- 逐字一致。所以不要在 SQL 里把身份列和名称列直接比较或连接，两种排序规则混用会报错。

CREATE TABLE IF NOT EXISTS feature_identities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  identity_key VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  first_name VARCHAR(191) NOT NULL,
  first_spec_version_id BIGINT UNSIGNED NOT NULL,
  retired_spec_version_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY feature_identities_product_key_unique (product_id, identity_key),
  KEY feature_identities_first_version_idx (first_spec_version_id),
  CONSTRAINT feature_identities_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 场景身份键是（所属功能身份，编号）的确定性编码，另外两列原样存这两个部分，方便按功能找场景。
CREATE TABLE IF NOT EXISTS scenario_identities (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  identity_key VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  feature_identity_key VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  reference VARCHAR(32) COLLATE utf8mb4_bin NOT NULL,
  first_spec_version_id BIGINT UNSIGNED NOT NULL,
  retired_spec_version_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY scenario_identities_product_key_unique (product_id, identity_key),
  KEY scenario_identities_product_feature_idx (product_id, feature_identity_key, reference),
  CONSTRAINT scenario_identities_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 关系记录：某个版本里对身份做了什么，kind 取 rename、merge、split、retire、restore。
-- 托管模式不给功能改名（模型给的新名字会折叠回旧名），所以首期只会出现 retire 和 restore，
-- 其余三种留给客户端增量协议。同一版本同一身份同一种关系只记一次，回填可以重复运行。
CREATE TABLE IF NOT EXISTS feature_identity_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  spec_version_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,
  from_identity_key VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  to_identity_key VARCHAR(191) COLLATE utf8mb4_bin NULL,
  name_key VARCHAR(191) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY feature_identity_links_version_unique (spec_version_id, kind, from_identity_key, name_key),
  KEY feature_identity_links_product_from_idx (product_id, from_identity_key),
  CONSTRAINT feature_identity_links_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS scenario_identity_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  spec_version_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,
  from_identity_key VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  to_identity_key VARCHAR(512) COLLATE utf8mb4_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY scenario_identity_links_version_unique (spec_version_id, kind, from_identity_key),
  KEY scenario_identity_links_product_from_idx (product_id, from_identity_key(191)),
  CONSTRAINT scenario_identity_links_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 既有表追加身份列。全部加在末尾并且可空，这样在大表上可以只改元数据，不用重建表。
ALTER TABLE spec_features
    ADD COLUMN identity_key VARCHAR(191) COLLATE utf8mb4_bin NULL,
    ADD COLUMN parent_identity_key VARCHAR(191) COLLATE utf8mb4_bin NULL;

ALTER TABLE spec_scenarios
    ADD COLUMN identity_key VARCHAR(512) COLLATE utf8mb4_bin NULL;

ALTER TABLE spec_changes
    ADD COLUMN feature_identity_key VARCHAR(191) COLLATE utf8mb4_bin NULL,
    ADD COLUMN scenario_identity_key VARCHAR(512) COLLATE utf8mb4_bin NULL;

ALTER TABLE features
    ADD COLUMN identity_key VARCHAR(191) COLLATE utf8mb4_bin NULL;

ALTER TABLE scenarios
    ADD COLUMN identity_key VARCHAR(512) COLLATE utf8mb4_bin NULL;
