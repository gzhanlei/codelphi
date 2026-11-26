import type { RepositoryIdentity, RepositoryProvider } from "../client-proposal/contract";

/** 地址里看不出是哪一家时的默认值。自托管地址只给得出主机名；用户可以用 --provider 改（我的默认）。 */
export const DEFAULT_PROVIDER_FOR_UNKNOWN_HOST: Exclude<RepositoryProvider, "github" | "local"> = "gitlab";

const PUBLIC_HOSTS: Record<string, RepositoryProvider> = { "github.com": "github", "gitlab.com": "gitlab", "gitee.com": "gitee" };

/** 从主机名猜代码托管服务。自托管地址只看得出主机名，猜不出来时用默认值。 */
export function providerOfHost(host: string): RepositoryProvider {
  const lower = host.toLowerCase();
  if (lower in PUBLIC_HOSTS) return PUBLIC_HOSTS[lower];
  if (/gitea/i.test(lower)) return "gitea";
  return DEFAULT_PROVIDER_FOR_UNKNOWN_HOST;
}

/**
 * 从远端地址得出仓库身份（修订稿 §6）。
 * 去掉协议、用户名和令牌，去掉末尾的 .git，主机名小写；自托管地址保留主机名。地址里的令牌不进身份，也不进任何记录。
 * GitLab 的子组算在属主里。没有远端就是纯本地仓库：没有主机名和属主，名字取目录名。
 */
export function repositoryIdentityOf(remote: string | null | undefined, localName: string, options: { provider?: RepositoryProvider; name?: string } = {}): RepositoryIdentity {
  const address = remote?.trim() ?? "";
  const local: RepositoryIdentity = { repositoryId: null, provider: "local", host: null, owner: null, name: options.name ?? localName };
  if (address === "") return local;

  let host = "";
  let path = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
    const url = new URL(address);
    host = url.hostname;
    path = url.pathname;
  } else {
    const scpLike = /^(?:ssh:\/\/)?([^@/]+)@([^:/]+):(.+)$/.exec(address);
    if (!scpLike) return { ...local, provider: options.provider ?? DEFAULT_PROVIDER_FOR_UNKNOWN_HOST };
    host = scpLike[2];
    path = scpLike[3];
  }
  const segments = path.split("/").filter(Boolean).map((segment) => segment.replace(/\.git$/i, ""));
  const name = segments.pop();
  const owner = segments.join("/");
  const normalizedHost = host.toLowerCase();
  return {
    repositoryId: null,
    provider: options.provider ?? providerOfHost(normalizedHost),
    host: normalizedHost || null,
    owner: owner === "" ? null : owner,
    name: name === undefined || name === "" ? local.name : name,
  };
}

/** 去掉路径两边的引号（git 会给含空格、引号等字符的路径加引号），并把转义的引号和反斜杠还原。 */
export function unquotePath(path: string): string {
  return path.startsWith('"') && path.endsWith('"') && path.length >= 2 ? path.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : path;
}
