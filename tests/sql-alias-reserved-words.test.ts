import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 回归护栏：单元测试的 execute 是 mock，SQL 从未真正交给 MySQL 解析——
 * `analysis_trigger AS trigger`（TRIGGER 是保留字）曾让生产设置页 500 而测试全绿。
 * 这里扫描源码里所有 SQL 字符串字面量的 `AS <alias>`，别名撞保留字即失败。
 * 保留字清单以 MySQL 8.0 官方 keywords 表（带 (R) 标记）为准。
 */
const MYSQL_8_RESERVED_WORDS = new Set([
  "ADD", "ALL", "ALTER", "ANALYZE", "AND", "AS", "ASC", "ASENSITIVE", "BEFORE", "BETWEEN", "BIGINT", "BINARY",
  "BLOB", "BOTH", "BY", "CALL", "CASCADE", "CASE", "CHANGE", "CHAR", "CHARACTER", "CHECK", "COLLATE", "COLUMN",
  "CONDITION", "CONSTRAINT", "CONTINUE", "CONVERT", "CREATE", "CROSS", "CUBE", "CUME_DIST", "CURRENT_DATE",
  "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER", "CURSOR", "DATABASE", "DATABASES", "DAY_HOUR",
  "DAY_MICROSECOND", "DAY_MINUTE", "DAY_SECOND", "DEC", "DECIMAL", "DECLARE", "DEFAULT", "DELAYED", "DELETE",
  "DENSE_RANK", "DESC", "DESCRIBE", "DETERMINISTIC", "DISTINCT", "DISTINCTROW", "DIV", "DOUBLE", "DROP", "DUAL",
  "ELSE", "ELSEIF", "EMPTY", "ENCLOSED", "ESCAPED", "EXCEPT", "EXISTS", "EXIT", "EXPLAIN", "FALSE", "FETCH",
  "FIRST_VALUE", "FLOAT", "FLOAT4", "FLOAT8", "FOR", "FORCE", "FOREIGN", "FROM", "FULLTEXT", "GENERATED", "GRANT",
  "GROUP", "GROUPING", "GROUPS", "HAVING", "HIGH_PRIORITY", "HOUR_MICROSECOND", "HOUR_MINUTE", "HOUR_SECOND",
  "IF", "IGNORE", "IN", "INDEX", "INFILE", "INNER", "INOUT", "INSENSITIVE", "INSERT", "INT", "INT1", "INT2",
  "INT3", "INT4", "INT8", "INTEGER", "INTERSECT", "INTERVAL", "INTO", "IS", "ITERATE", "JOIN", "JSON_TABLE",
  "KEY", "KILL", "LATERAL", "LEAD", "LEADING", "LEAVE", "LEFT", "LIKE", "LIMIT", "LINEAR", "LINES", "LOAD",
  "LOCAL", "LOCALTIME", "LOCALTIMESTAMP", "LOCK", "LONG", "LONGBLOB", "LONGTEXT", "LOOP", "LOW_PRIORITY",
  "MEDIUMBLOB", "MEDIUMINT", "MEDIUMTEXT", "MIDDLEINT", "MINUTE_MICROSECOND", "MINUTE_SECOND", "MOD", "MODIFIES",
  "NTH_VALUE", "NTILE", "NULL", "NUMERIC", "OF", "ON", "OPTION", "OPTIONALLY", "OR", "ORDER", "OUT", "OUTER",
  "OUTFILE", "PARTITION", "PERCENT_RANK", "PRECISION", "PRIMARY", "PROCEDURE", "PURGE", "RANGE", "RANK", "READ",
  "READS", "READ_WRITE", "REAL", "RECURSIVE", "REFERENCES", "REGEXP", "RELEASE", "RENAME", "REPEAT", "REPLACE",
  "REQUIRE", "RESIGNAL", "RESTRICT", "RETURN", "REVOKE", "RIGHT", "RLIKE", "ROW", "ROWS", "ROW_NUMBER", "SCHEMA",
  "SCHEMAS", "SECOND_MICROSECOND", "SELECT", "SENSITIVE", "SEPARATOR", "SET", "SHOW", "SIGNAL", "SMALLINT",
  "SPATIAL", "SPECIFIC", "SQL", "SQL_BIG_RESULT", "SQL_CALC_FOUND_ROWS", "SQL_SMALL_RESULT", "SQLEXCEPTION",
  "SQLSTATE", "SQLWARNING", "SSL", "STARTING", "STORED", "STRAIGHT_JOIN", "SYSTEM", "TERMINATED", "THEN",
  "TINYBLOB", "TINYINT", "TINYTEXT", "TO", "TRAILING", "TRIGGER", "TRUE", "UNDO", "UNION", "UNIQUE", "UNLOCK",
  "UNSIGNED", "UPDATE", "USAGE", "USE", "USING", "UTC_DATE", "UTC_TIME", "UTC_TIMESTAMP", "VALUES", "VARBINARY",
  "VARCHAR", "VARCHARACTER", "VARYING", "VIRTUAL", "WHEN", "WHERE", "WHILE", "WINDOW", "WITH", "WRITE", "XOR",
  "YEAR_MONTH", "ZEROFILL",
]);

/** 语句级判定，避免把错误消息散文当 SQL。 */
const SQL_STATEMENT = /\bSELECT\s[\s\S]+\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\S+\s+SET\b|\bDELETE\s+FROM\b/i;
const STRING_LITERAL = /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const ALIAS = /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/g;

function* walkFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (/\.(ts|tsx|sql)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield full;
  }
}

describe("SQL alias reserved words", () => {
  it("never aliases a column to a MySQL reserved word (server-side parse error)", () => {
    const violations: string[] = [];
    for (const root of ["lib", "app", "migrations"]) {
      for (const file of walkFiles(root)) {
        const source = readFileSync(file, "utf8");
        for (const literal of source.matchAll(STRING_LITERAL)) {
          if (!SQL_STATEMENT.test(literal[0])) continue;
          for (const alias of literal[0].matchAll(ALIAS)) {
            if (MYSQL_8_RESERVED_WORDS.has(alias[1].toUpperCase())) {
              const line = source.slice(0, (literal.index ?? 0) + (alias.index ?? 0)).split("\n").length;
              violations.push(`${file}:${line} — AS ${alias[1]}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
