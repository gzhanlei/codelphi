import { getDb } from "./db";
import type { SessionUser } from "./types";

type Execute = (statement: string, parameters: Array<string | null>) => Promise<unknown>;

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
