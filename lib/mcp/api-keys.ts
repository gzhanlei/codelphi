import { createHash, randomBytes } from "node:crypto";
import type { Execute } from "../db";

/**
 * A1 MCP server 的组织级只读 API key（docs/specsight-gap-improvement-plan.md §4.1）。
 * 明文只 sk_cd_ + 32 hex，仅在创建时返回一次；库中只存 SHA-256 哈希、
 * 前缀与「sk_cd_ 后 8 位」可识别片段，软撤销保留审计（revoked_at）。
 */

export const MCP_KEY_PREFIX = "sk_cd_";

export function hashApiKey(plaintext: string) {
  return createHash("sha256").update(plaintext).digest("hex");
}

export interface CreatedApiKey {
  id: number;
  plaintext: string;
}

export async function createApiKey(connection: { execute: Execute }, input: { organizationId: number; name: string; createdBy: string }): Promise<CreatedApiKey> {
  const plaintext = MCP_KEY_PREFIX + randomBytes(16).toString("hex");
  const insertResult = (await connection.execute(
    `INSERT INTO mcp_api_keys (organization_id, name, key_hash, key_prefix, key_hint, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.organizationId, input.name, hashApiKey(plaintext), MCP_KEY_PREFIX, plaintext.slice(MCP_KEY_PREFIX.length, MCP_KEY_PREFIX.length + 8), input.createdBy],
  )) as unknown;
  const first = Array.isArray(insertResult) ? insertResult[0] : insertResult;
  return { id: Number((first as { insertId: number }).insertId), plaintext };
}

export interface McpKeyIdentity {
  keyId: number;
  organizationId: number;
}

/** 无效 / 未知 / 已撤销 key 一律返回 null（防枚举，不区分原因）。 */
export async function verifyApiKey(connection: { execute: Execute }, plaintext: string): Promise<McpKeyIdentity | null> {
  if (!plaintext.startsWith(MCP_KEY_PREFIX)) return null;
  const [rows] = (await connection.execute(
    "SELECT id, organization_id AS organizationId, revoked_at AS revokedAt FROM mcp_api_keys WHERE key_hash = ?",
    [hashApiKey(plaintext)],
  )) as [Array<{ id: number; organizationId: number; revokedAt: Date | null }>, unknown];
  const row = rows[0];
  if (!row || row.revokedAt) return null;
  return { keyId: Number(row.id), organizationId: Number(row.organizationId) };
}
