#!/usr/bin/env node
/**
 * Task 15 bench 专用：把生产库（radar）的 GitHub App 连接行复制进 scratch 库
 * （codelphi_bench），organization_id 重映射为 bench org 1，并指向 bench 仓库行。
 * 加密密钥两侧相同（bench .env 复制自生产），密文原样复制即可解密。
 * 只打印 id/计数，绝不打印任何凭证内容。
 */
const mysql = require("/data/www/codelphi-bench/app/node_modules/mysql2/promise");
const fs = require("fs");

function readUrl(file) {
  return new URL(
    fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=")).slice(14).trim(),
  );
}

(async () => {
  const prodUrl = readUrl("/data/www/codelphi-docker/.env");
  const benchUrl = readUrl("/data/www/codelphi-bench/app/.env");
  const opts = (u, db) => ({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: db,
    charset: "utf8mb4",
    ssl: false,
  });
  const prod = await mysql.createConnection(opts(prodUrl, "radar"));
  const bench = await mysql.createConnection(opts(benchUrl, "codelphi_bench"));

  const [apps] = await prod.query("SELECT * FROM github_apps");
  const [connections] = await prod.query(
    "SELECT * FROM github_connections WHERE status = 'active' AND account_login = 'gzhanlei' ORDER BY id",
  );
  console.log(`prod rows: apps=${apps.length} activeGzhanleiConnections=${connections.length}`);
  if (connections.length === 0) {
    const [all] = await prod.query("SELECT id, account_login, account_type, status FROM github_connections");
    console.log("all prod connections:", JSON.stringify(all));
    process.exit(1);
  }

  for (const app of apps) {
    await bench.query(
      `INSERT INTO github_apps (id, slug, app_id, client_id, client_secret_encrypted, pem_encrypted, webhook_secret_encrypted)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE app_id = VALUES(app_id), client_id = VALUES(client_id)`,
      [app.id, app.slug, app.app_id, app.client_id, app.client_secret_encrypted, app.pem_encrypted, app.webhook_secret_encrypted ?? null],
    );
  }
  let copiedId = null;
  for (const connection of connections) {
    await bench.query(
      `INSERT INTO github_connections
         (id, app_id, installation_id, account_login, account_type, status, organization_id)
       VALUES (?, ?, ?, ?, ?, 'active', 1)
       ON DUPLICATE KEY UPDATE installation_id = VALUES(installation_id), status = 'active', organization_id = 1`,
      [connection.id, connection.app_id, connection.installation_id, connection.account_login, connection.account_type],
    );
    copiedId ??= connection.id;
  }
  await bench.query("UPDATE repositories SET connection_id = ? WHERE owner = 'gzhanlei' AND name = 'codelphi'", [copiedId]);
  const [check] = await bench.query("SELECT id, connection_id FROM repositories WHERE owner = 'gzhanlei' AND name = 'codelphi'");
  console.log(`copied connectionId=${copiedId} repo=${JSON.stringify(check[0])}`);
  await prod.end();
  await bench.end();
})().catch((error) => {
  console.error("COPY_FAIL:", error.code || error.message);
  process.exit(1);
});
