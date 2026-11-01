import "dotenv/config";
import mysql from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";

async function createDatabase() {
  const config = databaseConfig();
  const database = config.database;
  if (!database || !/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error("DATABASE_URL must contain a simple database name");
  }
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
