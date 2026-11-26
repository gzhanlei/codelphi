-- 客户端分析（修订稿《客户端分析修订：全量 + 增量、不传源码与补丁、提案式合并》§4.6、§6）。
-- 分析在租户的客户端跑，客户端交一份提案，服务端不读源码、不调模型，用现有的合并逻辑落成规格版本和发布。
--
-- 只做加法。部署时迁移先于新应用运行，旧应用忽略这些列照常服务，回滚只回滚镜像。
--
-- products.analysis_executor 表示「谁来分析」：server（默认，行为不变）或 client。
-- 第 1 期是受控试点，没有设置界面，由运营逐个产品在数据库里改。
-- 不复用 analyze_mode，那一列表示的是「全量还是增量」。
--
-- repositories.host 是仓库身份里的主机名，自托管实例靠它和公共主机区分。
-- 只加列，不改现有的唯一键 (provider, owner, name)：改它会动到托管的建仓路径。
--
-- analysis_runs 上记提案的幂等键和内容哈希，同一仓库内各自唯一。托管的 run 这两列是空的，
-- 唯一索引不约束空值。
--
-- spec_versions.provenance_json 是每一版的来源信息，分 server（服务端确认）和 client（客户端声明）两组。
-- 为空就是托管分析，历史版本不回填。
--
-- client_proposal_rejections 是提案被拒绝时的审计。只记是谁、哪个提交、什么错误码和机器可读的细节，
-- 不存请求体里的任何内容。

ALTER TABLE products
    ADD COLUMN analysis_executor VARCHAR(16) NOT NULL DEFAULT 'server';

ALTER TABLE repositories
    ADD COLUMN host VARCHAR(191) NULL;

ALTER TABLE analysis_runs
    ADD COLUMN client_idempotency_key VARCHAR(36) NULL,
    ADD COLUMN client_proposal_hash CHAR(64) NULL,
    ADD UNIQUE KEY analysis_runs_client_idempotency_unique (repository_id, client_idempotency_key),
    ADD UNIQUE KEY analysis_runs_client_proposal_unique (repository_id, client_proposal_hash);

ALTER TABLE spec_versions
    ADD COLUMN provenance_json JSON NULL;

CREATE TABLE IF NOT EXISTS client_proposal_rejections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  repository_id BIGINT UNSIGNED NULL,
  revision_sha CHAR(12) NOT NULL,
  proposal_hash CHAR(64) NULL,
  error_code VARCHAR(64) NOT NULL,
  details_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY client_proposal_rejections_product_created_idx (product_id, created_at),
  CONSTRAINT client_proposal_rejections_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT client_proposal_rejections_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
