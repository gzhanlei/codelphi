#!/usr/bin/env node
/**
 * Task 15 bench seed（scratch 库 codelphi_bench 专用，幂等）。
 * 只在隔离 bench 库中插入最小行集：org 1（migrations 已建）+ 计费账户/试用钱包 +
 * 产品 codelphi（source_roots=app/lib/scripts/components——components 必须在内，否则
 *  前端组件不入行为清单=检测盲区假象）+ 仓库 gzhanlei/codelphi（connection_id=NULL
 * → 走服务器环境 GITHUB_TOKEN）。绝不触碰生产库 radar。
 */
const mysql = require("/data/www/codelphi-bench/app/node_modules/mysql2/promise");
const fs = require("fs");

const url = new URL(
  fs.readFileSync("/data/www/codelphi-bench/app/.env", "utf8")
    .split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=")).slice(14).trim(),
);

(async () => {
  const conn = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    charset: "utf8mb4",
    ssl: false,
  });

  await conn.query(
    "UPDATE billing_accounts SET plan_status = 'trialing', reconciliation_hold = 0, currency = 'CNY' WHERE account_id = 1",
  );
  await conn.query(
    `INSERT INTO billing_quota_wallets
       (account_id, quota_type, remaining_sau, reserved_sau, source_key, status, balance_after_remaining, balance_after_reserved)
     VALUES (1, 'trial', 50, 0, 'bench-seed-v1', 'active', 50, 0)
     ON DUPLICATE KEY UPDATE remaining_sau = VALUES(remaining_sau), status = 'active'`,
  );
  await conn.query(
    `INSERT INTO products (slug, name, description, organization_id, analyze_mode, source_roots)
     VALUES ('codelphi', 'CoDelphi', 'Task 15 bench seed', 1, 'full', JSON_ARRAY('app','lib','scripts','components'))
     ON DUPLICATE KEY UPDATE name = VALUES(name), analyze_mode = 'full', source_roots = VALUES(source_roots)`,
  );
  const [productRows] = await conn.query("SELECT id FROM products WHERE slug = 'codelphi'");
  const productId = productRows[0].id;
  await conn.query(
    `INSERT INTO repositories (product_id, owner, name, default_branch, connection_id)
     VALUES (?, 'gzhanlei', 'codelphi', 'main', NULL)
     ON DUPLICATE KEY UPDATE product_id = VALUES(product_id), connection_id = NULL`,
    [productId],
  );
  const [repoRows] = await conn.query("SELECT id FROM repositories WHERE owner = 'gzhanlei' AND name = 'codelphi'");
  console.log(JSON.stringify({ seeded: true, productId, repositoryId: repoRows[0].id }));
  await conn.end();
})().catch((error) => {
  console.error("SEED_FAIL:", error.code || error.message);
  process.exit(1);
});
