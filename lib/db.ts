import mysql, { type Pool } from "mysql2/promise";
import { databaseConfig } from "./database-config";

declare global {
  var codelphiDb: Pool | undefined;
}

export function getDb() {
  globalThis.codelphiDb ??= mysql.createPool(databaseConfig());
  return globalThis.codelphiDb;
}

/** 数据访问函数的可注入执行入口：生产走连接池，测试注入 stub。 */
export type Execute = (statement: string, parameters: Array<string | number | null>) => Promise<unknown>;

export const defaultExecute: Execute = (statement, parameters) => getDb().execute(statement, parameters);
