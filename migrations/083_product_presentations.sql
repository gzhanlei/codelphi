-- 产品理解层（083）：每产品一行的 Radar 式 presentation——核心能力归纳与典型使用场景（journeys）。
-- 旅程只是引用链（featureName + 场景编号），叙事文字（情境/操作/结果/证据）读侧从 features/scenarios 现取；
-- 本表只保存归组结果与生成元数据。继承 Radar 的红线：只重组已有规格，不新增事实。
-- fingerprint = 功能名/父子分组/场景编号与类别/语言的结构指纹（摘要措辞变化不触发重算）；
-- 未生成过的行 fingerprint 为空串。
-- pending + pending_fingerprint + next_attempt_at = 「规格已变但按节流间隔尚未重算」的待更新标记（sweep 领取），也是失败后的重试排期；
-- lease_until = 生成租约，防止并发重复生成（分析钩子 / sweep / 手动触发三路互斥）。
CREATE TABLE IF NOT EXISTS product_presentations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  spec_version_id BIGINT UNSIGNED NULL,
  language VARCHAR(8) NOT NULL DEFAULT 'zh-CN',
  status VARCHAR(16) NOT NULL DEFAULT 'failed',
  source VARCHAR(32) NOT NULL DEFAULT 'generated',
  tagline VARCHAR(300) NULL,
  capabilities_json JSON NOT NULL,
  journeys_json JSON NOT NULL,
  coverage_json JSON NULL,
  fingerprint CHAR(64) NOT NULL DEFAULT '',
  pending TINYINT(1) NOT NULL DEFAULT 0,
  pending_fingerprint CHAR(64) NULL,
  next_attempt_at DATETIME(3) NULL,
  lease_until DATETIME(3) NULL,
  model_name VARCHAR(120) NULL,
  passes INT NOT NULL DEFAULT 0,
  last_error VARCHAR(500) NULL,
  last_attempt_at DATETIME(3) NULL,
  -- 连续失败次数（成功即清零）：从未成功过的产品前几次快速重试，之后退避为每天一次，避免持续失败时无上限地花模型调用。
  failure_count INT NOT NULL DEFAULT 0,
  generated_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY product_presentations_product_unique (product_id),
  KEY product_presentations_pending_idx (pending, next_attempt_at),
  CONSTRAINT product_presentations_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
