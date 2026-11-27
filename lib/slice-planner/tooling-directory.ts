/**
 * 开发工具目录：scripts、hack、bin 这类目录装的是开发、构建和运维的脚本，不是产品运行时的行为。
 * codelphi 自己的账本里有 844 条场景引用 scripts/ 下的文件，读得再多也长不出产品行为，却实打实地花模型额度。
 *
 * 例外是入口：有的产品真把启动脚本放在这种目录里（Procfile 的 web: node scripts/server.js，
 * Dockerfile 的 CMD，package.json 的 bin 和 start）。所以不是整目录一刀切，而是：
 *   目录里的文件默认不进分析，除非上一级目录里有东西会在生产上运行它、并且点到了它的路径。
 * 「点到」只认上面这几类启动文件里出现的路径，不读脚本内容，对任何技术栈都一样。
 *
 * 两条保守的边界：
 *   - 只认直接放在产品源码根目录（或仓库根）下的，或者上一级带着包描述文件的。埋在源码更深处的
 *     同名目录可能是产品的一个模块（src/tools/format.ts）。
 *   - 整个范围里除了工具目录什么都没有（没有别的代码目录，也没有构建清单）：那些脚本就是产品，不当工具目录。
 *
 * tools 没有列入惯例名：Python 和 Django 项目里它常常是产品自己的工具模块。
 *
 * 这一层只在规划器和覆盖率的枚举里起作用，不是纯路径规则：判断要看目录清单和启动文件的内容。
 */
import { analysisNoiseKind, isBuildManifest } from "../analysis-target";
import { isPackageDescriptor } from "./vendored-directory";
import type { OpenedRemoteSourceRevision, SourceScopeRoot, SourceTreeEntry } from "../remote-source-index/types";

/** 没有歧义的开发工具目录名。 */
const TOOLING_NAMES: ReadonlySet<string> = new Set(["scripts", "script", "tooling", "devtools", "dev-tools", "hack", "hacks", "bin"]);

/** 包清单里把产品跑起来的命令。build、test、lint、migrate 是开发命令，点了名也不算。 */
const RUNTIME_SCRIPT = /^(?:start|serve|run|dev|develop|preview|worker|daemon|cron)(?::[-\w]+)?$/;
const MANIFEST_NAMES: ReadonlySet<string> = new Set(["package.json", "composer.json"]);
const PROCFILE = /^procfile(?:[.\-][-\w]+)?$/i;
/** 启动文件都很短。 */
const maxInvokerLines = 600;

const basenameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
};

/**
 * 一个目录是不是工具目录：名字是惯例名，并且它的上一级是产品的源码根目录（或仓库根），或者带着包描述文件。
 */
export function isToolingDirectory(path: string, parentEntries: readonly SourceTreeEntry[], parentIsScopeRoot: boolean): boolean {
  if (!TOOLING_NAMES.has(basenameOf(path).toLowerCase())) return false;
  return parentIsScopeRoot || parentEntries.some((entry) => entry.type === "blob" && isPackageDescriptor(entry.path));
}

/**
 * 这个范围里除了工具目录还有没有别的东西：一个不在分析目标之外的代码目录，或者一份构建清单。
 * 没有就说明那些脚本就是产品。
 */
export function toolingDirectoriesApply(scopeRootEntries: readonly SourceTreeEntry[]): boolean {
  return scopeRootEntries.some((entry) => {
    if (entry.pruned) return false;
    if (entry.type === "blob") return isBuildManifest(entry.path);
    return !TOOLING_NAMES.has(basenameOf(entry.path).toLowerCase()) && analysisNoiseKind(`${entry.path}/file.z`) === null;
  });
}

function isInvoker(path: string): boolean {
  const name = basenameOf(path);
  return MANIFEST_NAMES.has(name.toLowerCase()) || PROCFILE.test(name) || analysisNoiseKind(path) === "deployment";
}

/** 命令里像文件路径的词：带斜杠、以扩展名结尾。 */
function pathTokens(lines: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const line of lines) {
    for (const token of line.split(/[\s"'`',;|&<>()\[\]]+/)) {
      if (!token.includes("/") || !/\.[a-z0-9]{1,8}$/i.test(token)) continue;
      tokens.push(token.replace(/^\.\//, ""));
    }
  }
  return tokens;
}

function manifestReferences(text: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const manifest = parsed as Record<string, unknown>;
  const references: string[] = [];
  const bin = manifest.bin;
  const binaries: unknown[] = typeof bin === "string" ? [bin] : Array.isArray(bin) ? bin : bin && typeof bin === "object" ? Object.values(bin as Record<string, unknown>) : [];
  for (const item of binaries) if (typeof item === "string") references.push(item.replace(/^\.\//, ""));
  if (manifest.scripts && typeof manifest.scripts === "object") {
    for (const [name, command] of Object.entries(manifest.scripts as Record<string, unknown>)) {
      if (RUNTIME_SCRIPT.test(name) && typeof command === "string") references.push(...pathTokens([command]));
    }
  }
  return references;
}

/**
 * 一个启动文件点到的路径，原样交回（相对它所在目录或相对仓库根，由调用方解析；绝对路径也原样）。
 * 清单能解析就按结构读，解析不了（注释、尾逗号）就当普通文本扫。
 */
export function referencedPaths(invokerPath: string, lines: readonly string[]): string[] {
  if (!isInvoker(invokerPath)) return [];
  const name = basenameOf(invokerPath).toLowerCase();
  if (MANIFEST_NAMES.has(name)) {
    const structured = manifestReferences(lines.join("\n"));
    if (structured) return structured;
  }
  return [...new Set(pathTokens(lines))];
}

/** 一个被点到的路径在这个工具目录下对应哪个文件。 */
function candidatesFor(directory: string, reference: string): string[] {
  if (!reference.startsWith("/")) {
    const parent = parentOf(directory);
    return parent === "" ? [reference] : [reference, `${parent}/${reference}`];
  }
  // 容器或 systemd 单元里的绝对路径（/opt/app/scripts/serve.py）：从工具目录的名字起截，接回它实际的位置。
  const byName = reference.toLowerCase().indexOf(`/${basenameOf(directory).toLowerCase()}/`);
  if (byName === -1) return [];
  const parent = parentOf(directory);
  return [parent === "" ? reference.slice(byName + 1) : `${parent}/${reference.slice(byName + 1)}`];
}

export interface ToolingLocation {
  directory: string;
  /** 这个工具目录里被启动文件点到的文件。 */
  entryPoints: Set<string>;
}

/**
 * 规划器和覆盖率的枚举共用的判定，结果有缓存：两边对同一个目录的答案一致。
 */
export class ToolingDirectories {
  private readonly entryPoints = new Map<string, Promise<Set<string>>>();
  private readonly applies = new Map<string, Promise<boolean>>();

  constructor(
    private readonly index: OpenedRemoteSourceRevision,
    private readonly scopeRoots: readonly SourceScopeRoot[],
  ) {}

  /** 仓库根只有在范围就是整个仓库时才算范围根：产品是 apps/api 时，仓库根下的目录不在它的范围里。没有配置范围根就是整个仓库。 */
  private isScopeRoot(path: string): boolean {
    return path === "" ? this.scopeRoots.length === 0 || this.scopeRoots.some((root) => root.path === "") : this.scopeRoots.some((root) => root.path === path);
  }

  /** 文件所在的那个范围根的清单（已经在别处列过的，可以直接传进来）。 */
  private async entriesOf(path: string): Promise<readonly SourceTreeEntry[]> {
    const listing = path === "" ? await this.index.listRoot() : await this.index.listDir(path);
    return listing.entries;
  }

  isToolingDirectory(directory: string, parentEntries: readonly SourceTreeEntry[]): boolean {
    return isToolingDirectory(directory, parentEntries, this.isScopeRoot(parentOf(directory)));
  }

  /** 包含这个路径的范围根；配置了多个时取最里层的。 */
  scopeRootOf(path: string): string {
    let scope = "";
    for (const root of this.scopeRoots) {
      if (path === root.path || path.startsWith(`${root.path}/`)) {
        if (root.path.length > scope.length) scope = root.path;
      }
    }
    return scope;
  }

  /** 这个范围根下要不要把工具目录当工具目录。 */
  appliesWithin(scopeRoot: string, scopeRootEntries?: readonly SourceTreeEntry[]): Promise<boolean> {
    let result = this.applies.get(scopeRoot);
    if (!result) {
      result = (scopeRootEntries ? Promise.resolve(scopeRootEntries) : this.entriesOf(scopeRoot)).then(toolingDirectoriesApply).catch(() => false);
      this.applies.set(scopeRoot, result);
    }
    return result;
  }

  /** 工具目录里被启动文件点到的文件。 */
  entryPointsOf(directory: string, parentEntries?: readonly SourceTreeEntry[]): Promise<Set<string>> {
    let result = this.entryPoints.get(directory);
    if (!result) {
      result = this.readEntryPoints(directory, parentEntries).catch(() => new Set<string>());
      this.entryPoints.set(directory, result);
    }
    return result;
  }

  private async readEntryPoints(directory: string, parentEntries?: readonly SourceTreeEntry[]): Promise<Set<string>> {
    const entries = parentEntries ?? (await this.entriesOf(parentOf(directory)));
    const found = new Set<string>();
    for (const invoker of entries) {
      if (invoker.pruned || invoker.type !== "blob" || !isInvoker(invoker.path)) continue;
      let lines: string[];
      try {
        lines = (await this.index.readLines({ path: invoker.path, startLine: 1, endLine: maxInvokerLines, requestedBy: "profile", reason: "find which files of a tooling directory are started in production" })).lines;
      } catch {
        continue;
      }
      for (const reference of referencedPaths(invoker.path, lines)) {
        for (const candidate of candidatesFor(directory, reference)) {
          // 只收落在工具目录里的；scripts/../lib/x.ts 指到别处去了，不算。
          if (candidate.startsWith(`${directory}/`) && !candidate.includes("/../")) found.add(candidate);
        }
      }
    }
    return found;
  }

  /**
   * 一个文件所在的最近的工具目录和它的入口；没有就返回 null。
   * 只在某个祖先目录的名字像工具目录时才列它的上一级。
   */
  async enclosing(filePath: string): Promise<ToolingLocation | null> {
    for (let directory = parentOf(filePath); directory !== ""; directory = parentOf(directory)) {
      if (!TOOLING_NAMES.has(basenameOf(directory).toLowerCase())) continue;
      const parent = parentOf(directory);
      const entries = await this.entriesOf(parent);
      if (!this.isToolingDirectory(directory, entries)) continue;
      return { directory, entryPoints: await this.entryPointsOf(directory, entries) };
    }
    return null;
  }
}
