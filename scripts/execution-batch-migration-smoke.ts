/**
 * Execution batch migration smoke（计划 Task 2 Step 6）：验证 081 在真实 MySQL 上的
 * 唯一约束、MEDIUMTEXT 容量、事务回滚与 receipts 新列。只允许显式指向空 scratch 库——
 * 绝不默认连接 DATABASE_URL，避免误在生产库执行验证性写入。
 *
 * 用法：
 *   npm run db:migrate   # 先在 scratch 库应用迁移
 *   EXECUTION_BATCH_SMOKE_DATABASE_URL="mysql://user:pass@host:port/dbname" \
 *     npx tsx scripts/execution-batch-migration-smoke.ts
 *
 * 注意：脚本会把 DATABASE_URL 覆写为 smoke URL（withBatchTransaction 使用的连接池必须指向
 * 同一 scratch 库），并在会话内关闭外键检查以便用 run_id=0 造行；外键存在性改由
 * information_schema 校验。请在不含生产库离散连接变量的 shell 中运行。
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { makeBatchRequestKey, sha256Utf8 } from "../lib/execution-batch/identity";
import { withBatchTransaction } from "../lib/execution-batch/persistence";
import { MAX_BATCH_RESPONSE_BYTES } from "../lib/execution-batch/types";

const BATCH_TABLES = [
  "analysis_behavior_batch_plan_sets",
  "analysis_behavior_batch_plans",
  "analysis_behavior_batch_attempts",
  "analysis_behavior_batch_attempt_members",
  "analysis_behavior_batch_requests",
] as const;

// 夹具前缀必须保证加后缀后仍 ≤ CHAR(36)（batch_attempt_uuid 列宽=标准 UUID）：16+9=25 ✓
const SMOKE_RUN_HINT = "exec-batch-smoke";

interface Failure {
  check: string;
  detail: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "ER_DUP_ENTRY");
}

async function scalar(connection: mysql.Connection, statement: string, parameters: readonly unknown[] = []): Promise<unknown> {
  const [rows] = (await connection.query(statement, [...parameters])) as [Array<Record<string, unknown>>, unknown];
  return rows[0]?.[Object.keys(rows[0] ?? { v: null })[0]] ?? null;
}

async function main(): Promise<number> {
  const url = process.env.EXECUTION_BATCH_SMOKE_DATABASE_URL;
  if (!url) {
    console.error("缺少 EXECUTION_BATCH_SMOKE_DATABASE_URL：拒绝默认连接 DATABASE_URL（不得对生产库执行验证性写入）。");
    return 2;
  }
  const connection = await mysql.createConnection(url);
  // withBatchTransaction 经 getDb() 建池：把池也指向同一 scratch 库，杜绝双库写入。
  process.env.DATABASE_URL = url;
  // 造行使用 run_id=0（不真实存在）：关闭会话外键检查；外键存在性由 information_schema 检查覆盖。
  await connection.query("SET SESSION FOREIGN_KEY_CHECKS=0");
  const failures: Failure[] = [];
  const check = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ check: name, detail: error instanceof Error ? error.message : String(error) });
      console.error(`FAIL ${name}: ${failures[failures.length - 1]?.detail}`);
    }
  };

  try {
    const databaseName = await scalar(connection, "SELECT DATABASE() AS v");

    await check("five batch tables exist", async () => {
      const [rows] = (await connection.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = ? AND table_name IN (?)`,
        [databaseName, [...BATCH_TABLES]],
      )) as [Array<Record<string, unknown>>, unknown];
      const found = new Set(rows.map((row) => String(row.table_name ?? row.TABLE_NAME)));
      for (const table of BATCH_TABLES) {
        if (!found.has(table)) throw new Error(`缺少表 ${table}`);
      }
    });

    await check("receipts request columns and unique index", async () => {
      for (const column of ["request_key", "request_fingerprint", "duration_ms"]) {
        const count = await scalar(
          connection,
          `SELECT COUNT(*) AS v FROM information_schema.columns
            WHERE table_schema = ? AND table_name = 'llm_call_receipts' AND column_name = ?`,
          [databaseName, column],
        );
        if (Number(count) !== 1) throw new Error(`llm_call_receipts 缺列 ${column}`);
      }
      const uniqueCount = await scalar(
        connection,
        `SELECT COUNT(*) AS v FROM information_schema.statistics
          WHERE table_schema = ? AND table_name = 'llm_call_receipts'
            AND index_name = 'llm_call_receipts_request_key_unique' AND column_name = 'request_key'`,
        [databaseName],
      );
      if (Number(uniqueCount) !== 1) throw new Error("request_key 唯一索引缺失");
    });

    await check("raw_response uses MEDIUMTEXT and holds protocol bound", async () => {
      const dataType = await scalar(
        connection,
        `SELECT data_type AS v FROM information_schema.columns
          WHERE table_schema = ? AND table_name = 'analysis_behavior_batch_requests' AND column_name = 'raw_response'`,
        [databaseName],
      );
      if (dataType !== "mediumtext") throw new Error(`raw_response 类型为 ${String(dataType)}，应为 mediumtext`);
      // 容量实测：协议上限 +1 字节必须可容纳（协议上限 < 列容量，§23.8）。
      const oversized = "x".repeat(MAX_BATCH_RESPONSE_BYTES + 1);
      await connection.query(
        `INSERT INTO analysis_behavior_batch_requests
           (run_id, batch_attempt_uuid, request_key, request_stage, request_sequence, request_fingerprint, request_outcome, raw_response)
         VALUES (?, ?, ?, 'describe', 1, ?, 'prepared', ?)`,
        [0, SMOKE_RUN_HINT, makeBatchRequestKey({ batchAttemptUuid: SMOKE_RUN_HINT, stage: "describe", sequence: 0 }), sha256Utf8("bound"), oversized],
      );
      const storedLength = await scalar(
        connection,
        `SELECT CHAR_LENGTH(raw_response) AS v FROM analysis_behavior_batch_requests WHERE batch_attempt_uuid = ? AND request_stage = 'describe' AND request_sequence = 1`,
        [SMOKE_RUN_HINT],
      );
      if (Number(storedLength) !== MAX_BATCH_RESPONSE_BYTES + 1) {
        throw new Error(`MEDIUMTEXT 容量不足：写入 ${String(storedLength)} 字符`);
      }
    });

    await check("request_key is globally unique across stages and sequences", async () => {
      const key = makeBatchRequestKey({ batchAttemptUuid: SMOKE_RUN_HINT, stage: "describe", sequence: 2 });
      await connection.query(
        `INSERT INTO analysis_behavior_batch_requests
           (run_id, batch_attempt_uuid, request_key, request_stage, request_sequence, request_fingerprint, request_outcome)
         VALUES (?, ?, ?, 'describe', 2, ?, 'prepared')`,
        [0, SMOKE_RUN_HINT, key, sha256Utf8("dup")],
      );
      try {
        await connection.query(
          `INSERT INTO analysis_behavior_batch_requests
             (run_id, batch_attempt_uuid, request_key, request_stage, request_sequence, request_fingerprint, request_outcome)
           VALUES (?, ?, ?, 'judge', 1, ?, 'prepared')`,
          [0, `${SMOKE_RUN_HINT}-judge`, key, sha256Utf8("dup")],
        );
        throw new Error("重复 request_key 被接受（唯一索引未生效）");
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    });

    await check("member task attempt and attempt-task uniqueness", async () => {
      const member = {
        runId: 0,
        attempt: SMOKE_RUN_HINT,
        taskKey: "task|smoke",
        taskKeyHash: sha256Utf8("task|smoke"),
        requestTaskAttemptId: `${SMOKE_RUN_HINT}-task-attempt-1`,
        alias: "T1",
      };
      const insertMember = (attemptUuid: string, taskAttemptId: string, taskKeyHash: string): Promise<unknown> =>
        connection.query(
          `INSERT INTO analysis_behavior_batch_attempt_members
             (run_id, batch_attempt_uuid, task_key, task_key_hash, request_task_attempt_id, request_lease_identity, task_alias, ordered_region_aliases)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [member.runId, attemptUuid, member.taskKey, taskKeyHash, taskAttemptId, "smoke-lease", member.alias, JSON.stringify([{ anchorFragmentKey: "fragment|1", regionAlias: "R1" }])],
        );
      await insertMember(member.attempt, member.requestTaskAttemptId, member.taskKeyHash);
      // 同一 task attempt 不得挂到第二个 batch attempt
      try {
        await insertMember(`${SMOKE_RUN_HINT}-second`, member.requestTaskAttemptId, sha256Utf8("task|other"));
        throw new Error("重复 request_task_attempt_id 被接受");
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
      // 同一 attempt 内 task_key_hash 唯一
      try {
        await insertMember(member.attempt, `${SMOKE_RUN_HINT}-task-attempt-2`, member.taskKeyHash);
        throw new Error("重复 (attempt, task_key_hash) 被接受");
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    });

    await check("withBatchTransaction rolls back member insert on failure", async () => {
      const attemptUuid = `${SMOKE_RUN_HINT}-rollback`;
      const taskKeyHash = sha256Utf8("task|rollback");
      await withBatchTransaction(async (execute) => {
        await execute(
          `INSERT INTO analysis_behavior_batch_attempt_members
             (run_id, batch_attempt_uuid, task_key, task_key_hash, request_task_attempt_id, request_lease_identity, task_alias, ordered_region_aliases)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [0, attemptUuid, "task|rollback", taskKeyHash, `${SMOKE_RUN_HINT}-rollback-attempt`, "smoke-lease", "T1", JSON.stringify([])],
        );
        throw new Error("intentional rollback");
      }).then(
        () => {
          throw new Error("事务应当抛错");
        },
        () => undefined,
      );
      const remaining = await scalar(
        connection,
        `SELECT COUNT(*) AS v FROM analysis_behavior_batch_attempt_members WHERE batch_attempt_uuid = ?`,
        [attemptUuid],
      );
      if (Number(remaining) !== 0) throw new Error("rollback 后仍有半持久化 member 行");
    });

    await check("run_id foreign keys cascade to batch tables", async () => {
      const constraintCount = await scalar(
        connection,
        `SELECT COUNT(DISTINCT table_name) AS v FROM information_schema.referential_constraints
          WHERE constraint_schema = ? AND table_name IN (?) AND referenced_table_name = 'analysis_runs'`,
        [databaseName, [...BATCH_TABLES]],
      );
      if (Number(constraintCount) !== BATCH_TABLES.length) {
        throw new Error(`analysis_runs 外键覆盖 ${String(constraintCount)}/${BATCH_TABLES.length} 张表`);
      }
    });
  } finally {
    await connection.query(
      `DELETE FROM analysis_behavior_batch_attempt_members WHERE batch_attempt_uuid LIKE ? OR request_task_attempt_id LIKE ?`,
      [`${SMOKE_RUN_HINT}%`, `${SMOKE_RUN_HINT}%`],
    );
    await connection.query(
      `DELETE FROM analysis_behavior_batch_requests WHERE batch_attempt_uuid LIKE ? OR request_key LIKE ?`,
      [`${SMOKE_RUN_HINT}%`, `${SMOKE_RUN_HINT}%`],
    );
    await connection.query(`SET SESSION FOREIGN_KEY_CHECKS=1`);
    await connection.end();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} 项检查失败`);
    return 1;
  }
  console.log("\n全部 smoke 检查通过");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
