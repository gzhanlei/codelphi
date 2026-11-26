/**
 * 客户端分析的配置（修订稿 §5.2）：模型凭证和服务端配置放在仓库之外的一个文件里，不进提交。
 *
 * 文件里放五项：AI_BASE_URL、AI_API_KEY、AI_MODEL、CODELPHI_SERVER_URL、CODELPHI_SNAPSHOT_KEY。
 * 优先级只有一种说法：进程环境 > --env-file > 凭证文件。
 *
 * Key 的安全：新建的文件权限 0600；改写时不放宽已有的权限；先写同目录的临时文件再原子改名；
 * 描述配置时密钥只显示「已设置」。
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnvFile, serializeEnvFile } from "../env-file";

export const CREDENTIAL_KEYS = ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "CODELPHI_SERVER_URL", "CODELPHI_SNAPSHOT_KEY"] as const;
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

/** 不是密钥、但也能写在凭证文件里的配置。 */
export const OPTIONAL_KEYS = ["AI_TIMEOUT_MS"] as const;

/** 显示配置时只说「已设置」的项。 */
export const SECRET_KEYS: ReadonlySet<string> = new Set(["AI_API_KEY", "CODELPHI_SNAPSHOT_KEY"]);

export const DEFAULT_SERVER_URL = "https://codelphi.com";

const OWNER_ONLY = 0o600;

export function credentialsPath(input: { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; home?: string } = {}): string {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  if (env.CODELPHI_CREDENTIALS_FILE) return env.CODELPHI_CREDENTIALS_FILE;
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "codelphi", "credentials.env");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "codelphi", "credentials.env");
}

export async function readCredentials(path: string): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  // 格式不对的那几行读不出值：那个键就当作没配置，别的照常。
  return parseEnvFile(content).values;
}

/** 改写凭证文件：给出的键覆盖原有的，值为 null 的删掉。原子写：读的人不会看到写了一半的文件。 */
export async function writeCredentials(path: string, entries: Record<string, string | null>): Promise<void> {
  const merged = { ...(await readCredentials(path)) };
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serializeEnvFile(merged, CREDENTIAL_KEYS), { encoding: "utf8", mode: OWNER_ONLY, flag: "wx" });
    // 文件已经有了就沿用它原来的权限，但只收紧、不放宽。
    const existing = await stat(path).catch(() => null);
    await chmod(temporary, existing ? Math.min(existing.mode & 0o777, OWNER_ONLY) : OWNER_ONLY);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 三处来源合成一份配置。进程环境 > --env-file > 凭证文件。服务端地址缺省是公共实例。 */
export function resolveConfig(sources: { process?: Record<string, string | undefined>; envFile?: Record<string, string>; credentials?: Record<string, string> }): Record<string, string | undefined> {
  const pick = (key: string): string | undefined => {
    for (const source of [sources.process?.[key], sources.envFile?.[key], sources.credentials?.[key]]) if (source !== undefined && source !== "") return source;
    return undefined;
  };
  const resolved: Record<string, string | undefined> = {};
  for (const key of [...CREDENTIAL_KEYS, ...OPTIONAL_KEYS]) resolved[key] = pick(key);
  resolved.CODELPHI_SERVER_URL = resolved.CODELPHI_SERVER_URL || DEFAULT_SERVER_URL;
  return resolved;
}

/** 给人看的配置现状。密钥只说有没有，不说是什么。 */
export function describeConfig(config: Record<string, string | undefined>): Record<string, { state: "missing" } | { state: "set"; value?: string }> {
  const described: Record<string, { state: "missing" } | { state: "set"; value?: string }> = {};
  for (const key of CREDENTIAL_KEYS) {
    // 服务端地址不填就是公共实例，所以它从来不会是「没设置」。
    const value = key === "CODELPHI_SERVER_URL" ? config[key] || DEFAULT_SERVER_URL : config[key];
    described[key] = value === undefined || value === "" ? { state: "missing" } : SECRET_KEYS.has(key) ? { state: "set" } : { state: "set", value };
  }
  return described;
}
