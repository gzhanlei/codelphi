-- 个人工作区 slug 去身份化：org slug 将出现在产品 canonical URL（/products/{org}/{slug}）里，
-- 原 u-${chandler_sub} 会把 OAuth subject 暴露在链接中，改为不可回推的随机串。
-- u- 前缀保留为个人工作区专用；organizations.slug 的 UNIQUE 约束兜底随机碰撞。
UPDATE organizations
SET slug = CONCAT('u-', SUBSTRING(MD5(RAND()), 1, 10))
WHERE slug LIKE 'u-%';
