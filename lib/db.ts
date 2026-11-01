import mysql, { type Pool } from "mysql2/promise";
import { databaseConfig } from "./database-config";

declare global {
  var radarDb: Pool | undefined;
}

export function getDb() {
  globalThis.radarDb ??= mysql.createPool(databaseConfig());
  return globalThis.radarDb;
}
