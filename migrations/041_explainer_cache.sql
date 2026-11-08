-- Explainer 渲染结果缓存（契约 §10.4）：按 product + 当前 spec 版本复用，命中零 Chromium 调用；
-- 渲染需要 Chromium（此前线上 500 即因服务器缺 Chrome），缓存同时是成本与可用性保护。
CREATE TABLE IF NOT EXISTS explainer_cache (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  spec_version_id BIGINT UNSIGNED NOT NULL,
  html MEDIUMTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY explainer_cache_product_version_unique (product_id, spec_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
