-- 能力进展聚合的功能别名映射：功能改名后 spec_changes 仍存落库时的历史 feature_key，
-- 按原名分组会把同一能力拆成多行（外评审 2026-11-08 指出的 4 对重复，如
-- 「代码仓库连接 / 代码仓库连接管理」）。按 feature_aliases 显式归并到当前功能。
-- 不做自动合并——与 spec-rename 的 C-lite 哲学一致：错误合并的代价远大于错误标注；
-- 其他产品遇到改名可按需补行（alias_key/canonical_key 均为 specFeatureKey 归一化后的 stable key）。
CREATE TABLE IF NOT EXISTS feature_aliases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  alias_key VARCHAR(191) NOT NULL,
  canonical_key VARCHAR(191) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY feature_aliases_product_alias_unique (product_id, alias_key),
  CONSTRAINT feature_aliases_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO feature_aliases (product_id, alias_key, canonical_key)
SELECT id, '代码仓库连接管理', '代码仓库连接' FROM products WHERE slug = 'codelphi';

INSERT INTO feature_aliases (product_id, alias_key, canonical_key)
SELECT id, 'chandler 统一登录与会话', '统一登录与会话' FROM products WHERE slug = 'codelphi';

INSERT INTO feature_aliases (product_id, alias_key, canonical_key)
SELECT id, '产品总览仪表盘', '产品总览与产品页' FROM products WHERE slug = 'codelphi';

INSERT INTO feature_aliases (product_id, alias_key, canonical_key)
SELECT id, '分析失败反馈与 issue 提交', '分析失败反馈' FROM products WHERE slug = 'codelphi';
