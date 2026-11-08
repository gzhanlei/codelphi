import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Chandler token 密钥环（契约 M3-T1/§4.7 派生）：AES-256-GCM，密钥版本化——
 * 轮换期间旧密钥保留可解密、新写入用当前版本；密钥只经环境变量注入，不入库不入日志。
 *
 * TOKEN_ENCRYPTION_KEYS = {"1":"<base64 32字节>","2":"<base64 32字节>"}；TOKEN_ENCRYPTION_KEY_VERSION = "2"
 */

export interface TokenKeyring {
  versions: Record<string, Buffer>;
  currentVersion: string;
}

export function loadTokenKeyring(
  rawKeys: string | undefined = process.env.TOKEN_ENCRYPTION_KEYS,
  rawVersion: string | undefined = process.env.TOKEN_ENCRYPTION_KEY_VERSION,
): TokenKeyring {
  if (!rawKeys?.trim()) throw new Error("TOKEN_ENCRYPTION_KEYS is not configured");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEYS is not valid JSON");
  }
  const versions: Record<string, Buffer> = {};
  for (const [version, value] of Object.entries(parsed as Record<string, string>)) {
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) throw new Error(`TOKEN_ENCRYPTION_KEYS[${version}] must decode to 32 bytes`);
    versions[version] = key;
  }
  const currentVersion = rawVersion?.trim() || Object.keys(versions).sort().at(-1)!;
  if (!versions[currentVersion]) throw new Error(`TOKEN_ENCRYPTION_KEY_VERSION ${currentVersion} has no key in TOKEN_ENCRYPTION_KEYS`);
  return { versions, currentVersion };
}

/** AES-256-GCM 加密：输出 iv(12) + tag(16) + ciphertext 的二进制串，key_version 随行落库。 */
export function encryptToken(plaintext: string, keyring: TokenKeyring = loadTokenKeyring()): { cipher: Buffer; keyVersion: string } {
  const key = keyring.versions[keyring.currentVersion];
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { cipher: Buffer.concat([iv, cipher.getAuthTag(), encrypted]), keyVersion: keyring.currentVersion };
}

/** 解密：按行上的 key_version 取密钥；密钥已被轮换移除时抛错（提示保留旧密钥）。 */
export function decryptToken(cipher: Buffer, keyVersion: string, keyring: TokenKeyring = loadTokenKeyring()): string {
  const key = keyring.versions[keyVersion];
  if (!key) throw new Error(`token key version ${keyVersion} is not present in TOKEN_ENCRYPTION_KEYS`);
  const iv = cipher.subarray(0, 12);
  const tag = cipher.subarray(12, 28);
  const encrypted = cipher.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
