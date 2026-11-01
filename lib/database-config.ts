import type { PoolOptions } from "mysql2/promise";
import { requiredEnv } from "./env";

export function databaseConfig(multipleStatements = false): PoolOptions {
  const url = new URL(requiredEnv("DATABASE_URL"));
  if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must be a mysql:// URL");

  const useTls = process.env.DATABASE_SSL !== "false";
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    charset: "utf8mb4",
    timezone: "Z",
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 5,
    idleTimeout: 60_000,
    enableKeepAlive: true,
    multipleStatements,
    ssl: useTls ? { minVersion: "TLSv1.2", rejectUnauthorized: true } : undefined,
  };
}
