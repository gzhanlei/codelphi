/**
 * 真实 MySQL 演练共用的脚手架：建一个空的临时库、用仓库自己的迁移入口从零建表、用完删掉。
 *
 * 只接受库名以指定前缀开头的连接地址，而且绝不读 DATABASE_URL：这类脚本会删掉它指向的库，
 * 地址必须由调用方通过专门的环境变量给出来。它自己和它启动的子进程都不走 TLS：
 * 连接生产时的 TLS 设置不在这里验证。
 */
import { spawnSync } from "node:child_process";
import mysql, { type Pool } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";

/** 从连接地址里取出库名，并确认它是一个可以随便删了重建的临时库。 */
export function scratchDatabase(url: string, prefix: string, envName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${envName} 不是合法的连接地址`);
  }
  const name = parsed.pathname.replace(/^\//, "");
  if (parsed.protocol !== "mysql:" || !name.startsWith(prefix) || !/^[0-9a-z_]*$/.test(name.slice(prefix.length))) {
    throw new Error(`拒绝：这个脚本会删掉并重建它指向的库，库名必须以 ${prefix} 开头（收到的是「${name}」）`);
  }
  return name;
}

function runMigrations(): number {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`迁移失败（退出码 ${result.status}）：\n${output.slice(-3000)}`);
  return output.split("\n").filter((line) => line.startsWith("Applied ")).length;
}

/** 按结果集的第一行取自增编号。 */
export function insertIdOf(result: unknown): number {
  return Number((result as [{ insertId: number }, unknown])[0].insertId);
}

export interface ScratchDatabase {
  database: string;
  /** 这次从零执行的迁移文件数。 */
  migrations: number;
  serverVersion: string;
}

/**
 * 建库、建表，把连接池交给 work；work 返回或抛错之后都删掉临时库。
 * 它会改写本进程的 DATABASE_URL（仓库的连接池从这里读配置）和 DATABASE_SSL，只改这个进程和它启动的子进程。
 */
export async function withScratchDatabase<T>(
  options: { url: string; prefix: string; envName: string },
  work: (pool: Pool, info: ScratchDatabase) => Promise<T>,
): Promise<T> {
  const database = scratchDatabase(options.url, options.prefix, options.envName);
  process.env.DATABASE_URL = options.url;
  process.env.DATABASE_SSL = "false";
  const config = { ...databaseConfig(), ssl: undefined };
  const admin = await mysql.createConnection({ ...config, database: undefined });
  let pool: Pool | undefined;
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const [versionRows] = (await admin.query("SELECT VERSION() AS version")) as [{ version: string }[], unknown];
    const migrations = runMigrations();
    pool = mysql.createPool(config);
    return await work(pool, { database, migrations, serverVersion: versionRows[0].version });
  } finally {
    await pool?.end();
    // 被演练的代码会经 getDb() 另开一个全局连接池；不关掉它，进程在出错时不退出。
    await globalThis.codelphiDb?.end();
    globalThis.codelphiDb = undefined;
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await admin.end();
    }
  }
}
