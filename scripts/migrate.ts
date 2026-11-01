import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";

async function migrate() {
  const db = mysql.createPool(databaseConfig(true));
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    const directory = path.join(process.cwd(), "migrations");
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const [applied] = await db.execute("SELECT 1 FROM schema_migrations WHERE name = ?", [file]);
      if ((applied as unknown[]).length > 0) continue;

      const contents = await readFile(path.join(directory, file), "utf8");
      const statements = contents.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean);
      for (const statement of statements) await db.query(statement);
      await db.execute("INSERT INTO schema_migrations (name) VALUES (?)", [file]);
      console.log(`Applied ${file}`);
    }
  } finally {
    await db.end();
  }
}

migrate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
