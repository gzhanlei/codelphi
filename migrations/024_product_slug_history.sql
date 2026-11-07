-- 产品改名入口（slug 可改）：记录历史 slug，旧链接按历史表重定向。
CREATE TABLE IF NOT EXISTS product_slug_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  old_slug VARCHAR(128) NOT NULL,
  changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY product_slug_history_old_slug_unique (old_slug),
  KEY product_slug_history_product_idx (product_id),
  CONSTRAINT product_slug_history_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
