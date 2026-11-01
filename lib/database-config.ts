import type { PoolOptions } from "mysql2/promise";
import { requiredEnv } from "./env";

function databaseUrl() {
  const url = new URL(requiredEnv("DATABASE_URL"));
  if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must be a mysql:// URL");
  return url;
}

function databasePort(url: URL) {
  return Number(url.port || 3306);
}

function tlsOptions(): PoolOptions["ssl"] {
  return process.env.DATABASE_SSL === "false"
    ? undefined
    : { minVersion: "TLSv1.2", rejectUnauthorized: true };
}

export function databaseConfig(multipleStatements = false): PoolOptions {
  const url = databaseUrl();
  return {
    host: url.hostname,
    port: databasePort(url),
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
    ssl: tlsOptions(),
  };
}
