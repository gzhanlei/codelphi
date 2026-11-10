-- 介绍材料草稿（GTM 桥面批次 2）：AI 生成的结构化大纲，每块带账本锚点（content_json），
-- 以 (product, spec_version) 唯一——规格推进后重新生成即覆盖旧稿。
-- PPT 字段存 PPTCreator partner 任务的元数据：ppt_job_id 幂等键、ppt_project_id 轮询句柄、
-- ppt_status（queued/generating/completed/failed）、ppt_error（失败原因）。
CREATE TABLE IF NOT EXISTS intro_materials (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  spec_version_id BIGINT UNSIGNED NULL,
  content_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  ppt_project_id VARCHAR(64) NULL,
  ppt_job_id VARCHAR(64) NULL,
  ppt_status VARCHAR(16) NULL,
  ppt_error TEXT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY intro_materials_product_version_unique (product_id, spec_version_id),
  CONSTRAINT intro_materials_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
