-- 个人工作区 slug 去身份化：org slug 将出现在产品 canonical URL（/products/{org}/{slug}）里，
-- 原 u-${chandler_sub} 会把 OAuth subject 暴露在链接中，改为不可回推的随机串。
-- u- 前缀保留为个人工作区专用，organizations.slug 的 UNIQUE 约束兜底随机碰撞。
-- 取哈希结果的前 10 个十六进制字符。原先用的是 MD5()，MySQL 9 已经没有这个函数，
-- 换成 SHA2() 之后空的数据库在 8 和 9 上都能从零建起来。已经执行过这条迁移的环境不会重跑。
UPDATE organizations
SET slug = CONCAT('u-', SUBSTRING(SHA2(RAND(), 256), 1, 10))
WHERE slug LIKE 'u-%';
