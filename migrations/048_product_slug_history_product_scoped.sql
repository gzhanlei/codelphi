-- 产品 slug 历史改为产品内唯一：canonical URL 带 org 段后，跨工作区允许重名，
-- 旧 slug 的全局唯一会把别的 org 复用同名 slug 时的历史行挤掉。
ALTER TABLE product_slug_history
  DROP INDEX product_slug_history_old_slug_unique,
  ADD UNIQUE KEY product_slug_history_product_old_unique (product_id, old_slug);
