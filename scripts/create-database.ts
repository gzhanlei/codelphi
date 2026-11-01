import "dotenv/config";
import mysql, { type PoolOptions } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";

export function isValidDatabaseName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]+$/.test(value);
}

export function databaseName(config: PoolOptions) {
  const database = config.database;
  if (!isValidDatabaseName(database)) {
    throw new Error("DATABASE_URL must contain a simple database name");
  }
  return database;
}

async function createDatabase() {
  const config = databaseConfig();
  const database = databaseName(config);
  delete config.database;
  const connection = await mysql.createConnection(config);
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    console.log(`Database ${database} is ready`);
  } finally {
    await connection.end();
  }
}

createDatabase().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
