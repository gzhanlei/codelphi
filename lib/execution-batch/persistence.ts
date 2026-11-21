import { getDb } from "../db";

interface BatchTransactionConnection {
  beginTransaction(): Promise<unknown>;
  execute(statement: string, parameters: Array<string | number | null>): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  release(): void;
}

type Execute = (statement: string, parameters: Array<string | number | null>) => Promise<unknown>;

/**
 * batch 模块专用短事务：沿用 mysql2 connection 的 begin/commit/rollback/release，
 * 不引入全局事务框架（§23.1）。task claim 与 member insert 等原子对必须经由同一个
 * 事务 execute 完成（§23.2 C2.2），禁止在事务中调用自行从连接池取连接的封装。
 */
export async function withBatchTransaction<T>(fn: (execute: Execute) => Promise<T>): Promise<T> {
  const connection = (await getDb().getConnection()) as unknown as BatchTransactionConnection;
  try {
    await connection.beginTransaction();
    const result = await fn((statement, parameters) => connection.execute(statement, parameters));
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
