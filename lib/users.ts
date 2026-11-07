import { getDb } from "./db";
import type { SessionUser } from "./types";

type Execute = (statement: string, parameters: Array<string | null>) => Promise<unknown>;

/** 按 Chandler sub 定位 codelphi 用户 id；未登录过（无行）返回 null。 */
export async function findUserIdBySub(sub: string, execute: Execute = (sql, parameters) => getDb().execute(sql, parameters)): Promise<number | null> {
  const [rows] = await execute("SELECT id FROM users WHERE chandler_sub = ? LIMIT 1", [sub]) as [Array<{ id: number }>, unknown];
  return rows[0] ? Number(rows[0].id) : null;
}

export async function upsertCodelphiUser(profile: SessionUser, execute: Execute = (statement, parameters) => getDb().execute(statement, parameters)) {
  await execute(
    `INSERT INTO users (chandler_sub, email, display_name, picture_url)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       email = VALUES(email),
       display_name = VALUES(display_name),
       picture_url = VALUES(picture_url),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [profile.sub, profile.email ?? null, profile.name ?? null, profile.picture ?? null],
  );
}
