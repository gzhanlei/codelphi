-- 工作区自己的模型配置（2026-11-27 产品负责人决定：打开服务端分析开关的产品，必须先让用户填自己的模型配置，
-- CoDelphi 不替用户付模型费用）。
--
-- 每个工作区一行：模型服务地址、加密后的 API key、模型名。加密用 lib/secret-box.ts（AES-256-GCM，随机 IV），
-- 主密钥是 SESSION_SECRET，和 GitHub 集成的 secret 同一个。明文只在保存前验证那一次用到，不落库、不进日志。
-- 模型名最长 64 个字符，和 llm_call_receipts.model 一样长：回执里记的就是这个模型名。
--
-- 只做加法：一张新表，回执表一个可空的列（记这一次调用用的是谁的 key）。部署时迁移先于新应用运行，
-- 旧应用忽略它们照常服务，回滚只回滚镜像。

CREATE TABLE IF NOT EXISTS organization_models (
  organization_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  base_url VARCHAR(500) NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  model VARCHAR(64) NOT NULL,
  verified_at DATETIME(3) NOT NULL,
  created_by VARCHAR(191) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT organization_models_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE llm_call_receipts
    ADD COLUMN model_source VARCHAR(16) NULL;
