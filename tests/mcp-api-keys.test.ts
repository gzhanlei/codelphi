import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey, hashApiKey, verifyApiKey } from "../lib/mcp/api-keys";

const execute = vi.fn();
const connection = { execute } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mcp api keys", () => {
  it("hashes keys with sha-256 and never stores the plaintext", () => {
    const hash = hashApiKey("sk_cd_abcdef1234567890");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("sk_cd_");
  });

  it("creates a key returning the plaintext exactly once, persisting only hash/prefix/hint", async () => {
    execute.mockResolvedValue([{ insertId: 7 }]);
    const created = await createApiKey(connection, { organizationId: 5, name: "ci", createdBy: "user-1" });
    expect(created.plaintext).toMatch(/^sk_cd_[0-9a-f]{32}$/);
    const [sql, params] = execute.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO mcp_api_keys");
    const stored = params as unknown[];
    expect(stored).not.toContain(created.plaintext);
    expect(stored).toContain(hashApiKey(created.plaintext));
    expect(stored[3]).toBe("sk_cd_");
    // 前 8 位可识别片段（不含前缀本体）
    expect(stored[4]).toBe(created.plaintext.slice(6, 14));
  });

  it("verifies a valid key to its organization and rejects unknown/revoked keys", async () => {
    const created = { organizationId: 5, name: "ci", createdBy: "user-1" };
    const storedHash = { current: "" };
    const seed = async () => {
      execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (String(sql).includes("INSERT")) {
          storedHash.current = (params as unknown[])[2] as string;
          return [{ insertId: 7 }];
        }
        // 按真实唯一键语义：只有哈希命中的行才返回
        return (params as unknown[])[0] === storedHash.current ? [[{ id: 7, organizationId: 5, revokedAt: null }]] : [[]];
      });
    };
    await seed();
    const { plaintext } = await createApiKey(connection, created);
    const verified = await verifyApiKey(connection, plaintext);
    expect(verified).toEqual({ keyId: 7, organizationId: 5 });
    // 未知 key：不抛错，返回 null（防枚举）
    expect(await verifyApiKey(connection, "sk_cd_ffffffffffffffffffffffffffffffff")).toBeNull();
    execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("SELECT")) return (params as unknown[])[0] === storedHash.current ? [[{ id: 7, organizationId: 5, revokedAt: new Date() }]] : [[]];
      return [{ insertId: 7 }];
    });
    expect(await verifyApiKey(connection, plaintext)).toBeNull();
  });
});
