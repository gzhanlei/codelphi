-- 公开演示开关入库存档（原 PUBLIC_DEMO_SLUGS 环境变量改为产品设置页可配；env 白名单作为过渡兜底保留）。
ALTER TABLE products ADD COLUMN is_public_demo TINYINT(1) NOT NULL DEFAULT 0;
