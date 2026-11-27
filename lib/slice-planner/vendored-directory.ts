/**
 * 认出「原样拷进来的上游项目」：第三方代码的副本。
 *
 * 目录名只能认出 vendor、third_party、node_modules 这类惯例（lib/analysis-target.ts），
 * 认不出放在别的目录名下的：SalesBuddy 的 androidApp/src/main/jni/libopus 就是一个完整的 libopus 源码树，
 * 占过一次全量分析一半的文件。但拷进来的东西有它的样子——带着自己的许可证、AUTHORS、NEWS、
 * configure.ac、自己的 CI 配置。这里只看目录里有哪些文件名，不读源码，对任何技术栈的上游项目都一样。
 *
 * 两道判据：
 *   1. 带着一份和仓库自己的不一样的许可证（根目录有许可证可比时）。monorepo 里每个包都会复制一份
 *      根目录的许可证，那份算自己的：哈希不同时再比去掉数字和空白之后的文本（年份会变）。
 *   2. 没有自己的包描述文件，却同时带着三种以上上游项目的标记：许可证、AUTHORS/MAINTAINERS、
 *      NEWS/ChangeLog、autotools（configure.ac、*.m4、Makefile.am）、自己的 CI 配置。
 *      第一方包的标配是 README + LICENSE + CHANGELOG，只算两个标记，不会被误认。
 *
 * 包描述文件只认 package.json、go.mod、Cargo.toml 这类「一个包一个」的清单，加上 setup.py、Gemfile、
 * mix.exs 这些各生态的包定义。Makefile、configure、CMakeLists.txt 不算：拷进来的 C 项目也带着它们，
 * 认了它们，libopus 就认不出来了。
 *
 * 认不准的宁可不认：错把一个第一方包当成第三方，那一整块产品行为就从账本里消失了。
 */
import { basename } from "node:path";
import { isBuildManifest } from "../analysis-target";
import type { OpenedRemoteSourceRevision, SourceScopeRoot, SourceTreeEntry } from "../remote-source-index/types";

export type UpstreamMarker = "license" | "authors" | "news" | "autotools" | "ci";

export interface DirectoryVerdict {
  vendored: boolean;
  reason?: "foreign_license" | "upstream_project";
  /** 这个目录带着的标记。没被认成第三方时也照实返回，方便排查。 */
  markers: UpstreamMarker[];
}

const LICENSE_STEM = /^(?:licen[cs]e|copying|copyright|notice)(?:[-_.].*)?$/i;
const AUTHORS_NAME = /^(?:authors|maintainers|contributors|developers)(?:[._-].*)?$/i;
const NEWS_NAME = /^(?:news|changelog|changes|history|releases?|release[-_.]notes?|whatsnew)(?:[._-].*)?$/i;
const AUTOTOOLS_NAME = /^(?:configure(?:\.ac|\.in)?|autogen\.(?:sh|bat)|bootstrap|makefile\.am|.*\.m4)$/i;
/** 各生态「一个包一个」的描述文件，不含构建脚本。 */
const PACKAGE_DESCRIPTOR =
  /(?:^|\/)(?:setup\.py|setup\.cfg|pyproject\.toml|gemfile|[^/]+\.gemspec|build\.sbt|mix\.exs|package\.swift|pubspec\.yaml|deno\.json|stack\.ya?ml|[^/]+\.cabal|rebar\.config|shard\.ya?ml|build\.zig)$/i;

/** 这个目录是不是一个「包」：带着自己的包描述文件。 */
export function isPackageDescriptor(path: string): boolean {
  return isBuildManifest(path) || PACKAGE_DESCRIPTOR.test(path);
}

const OWN_CI_NAME = /^(?:\.travis\.yml|\.appveyor\.yml|appveyor\.yml|\.gitlab-ci\.yml|\.drone\.yml|azure-pipelines\.yml|\.circleci|\.github|jenkinsfile)$/i;

/** 文档和纯文本的后缀：LICENSE.md、COPYING.txt、NOTICE。 */
const TEXT_EXTENSIONS = /\.(?:md|txt|rst)$/i;
/** 源文件的后缀：copyright.ts、notice.py 是代码，不是许可证。 */
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx|jsx|py|go|java|kt|kts|rb|php|cs|swift|m|mm|c|cc|cpp|h|hpp|rs|dart|vue|svelte|lua|ex|exs|erl|hs|clj|scala|groovy|sh|json|ya?ml|xml)$/i;

export function isLicenseName(name: string): boolean {
  const stem = TEXT_EXTENSIONS.test(name) ? name.slice(0, name.lastIndexOf(".")) : name;
  return LICENSE_STEM.test(stem) && !SOURCE_EXTENSION.test(stem);
}

/** 这个目录自己的许可证文件，不含子目录里的。 */
export function licenseFilesOf(entries: readonly SourceTreeEntry[]): SourceTreeEntry[] {
  return entries.filter((entry) => entry.type === "blob" && isLicenseName(basename(entry.path)));
}

export function upstreamMarkersOf(entries: readonly SourceTreeEntry[]): UpstreamMarker[] {
  const markers = new Set<UpstreamMarker>();
  for (const entry of entries) {
    const name = basename(entry.path);
    if (entry.type === "blob") {
      if (isLicenseName(name)) markers.add("license");
      if (AUTHORS_NAME.test(name)) markers.add("authors");
      if (NEWS_NAME.test(name)) markers.add("news");
      if (AUTOTOOLS_NAME.test(name)) markers.add("autotools");
    }
    if (OWN_CI_NAME.test(name)) markers.add("ci");
  }
  return ["license", "authors", "news", "autotools", "ci"].filter((marker) => markers.has(marker as UpstreamMarker)) as UpstreamMarker[];
}

/**
 * 只凭一个目录的清单判断它是不是拷进来的上游项目。
 * ownLicenseShas 是「这个仓库自己的许可证」的哈希：根目录的，加上已经比过文本、确认相同的。
 */
export function inspectDirectory(
  entries: readonly SourceTreeEntry[],
  context: { ownLicenseShas: ReadonlySet<string>; rootHasLicense: boolean },
): DirectoryVerdict {
  const markers = upstreamMarkersOf(entries);
  const licences = licenseFilesOf(entries);
  if (context.rootHasLicense && licences.some((licence) => !context.ownLicenseShas.has(licence.sha))) {
    return { vendored: true, reason: "foreign_license", markers };
  }
  // 自己的许可证不算标记：否则「同一份许可证 + 更新日志 + 自己的 CI」的第一方包会被数成三个。
  const counted = licences.length > 0 && licences.every((licence) => context.ownLicenseShas.has(licence.sha))
    ? markers.filter((marker) => marker !== "license")
    : markers;
  if (!entries.some((entry) => entry.type === "blob" && isPackageDescriptor(entry.path)) && counted.length >= 3) {
    return { vendored: true, reason: "upstream_project", markers };
  }
  return { vendored: false, markers };
}

/** 去掉数字、空白和标点，只剩字母：同一份许可证换了年份、换了换行，比出来还是一样。 */
function normalizeLicenseText(lines: readonly string[]): string {
  return lines.join("\n").toLowerCase().replace(/[^a-z]+/g, "");
}
const maxLicenseLines = 600;

/**
 * 带缓存的判定器。规划器遍历时每个目录问一次；覆盖率的枚举也问它，两边对同一个目录的答案一致。
 */
export class VendoredDirectoryDetector {
  private readonly verdicts = new Map<string, Promise<DirectoryVerdict>>();
  private readonly licenceTexts = new Map<string, Promise<string>>();
  private root?: Promise<Array<{ sha: string; text: Promise<string> }>>;

  constructor(
    private readonly index: OpenedRemoteSourceRevision,
    private readonly scopeRoots: readonly SourceScopeRoot[],
  ) {}

  /**
   * 仓库根、产品的源码根目录和它的祖先，永远不算第三方：用户明确把产品指到了那里。
   * 源码根是整个仓库（path 为空）时，只保护仓库根自己。
   */
  private isProtected(path: string): boolean {
    if (path === "") return true;
    return this.scopeRoots.some((root) => root.path !== "" && (root.path === path || root.path.startsWith(`${path}/`)));
  }

  private readLicenseText(path: string): Promise<string> {
    let text = this.licenceTexts.get(path);
    if (!text) {
      text = this.index
        .readLines({ path, startLine: 1, endLine: maxLicenseLines, requestedBy: "profile", reason: "compare a nested licence with the repository's own" })
        .then((read) => normalizeLicenseText(read.lines))
        .catch(() => "");
      this.licenceTexts.set(path, text);
    }
    return text;
  }

  private rootLicences(): Promise<Array<{ sha: string; text: Promise<string> }>> {
    this.root ??= this.index.listRoot().then((root) => licenseFilesOf(root.entries).map((licence) => ({ sha: licence.sha, text: this.readLicenseText(licence.path) })));
    return this.root;
  }

  private async ownLicencesOf(entries: readonly SourceTreeEntry[]): Promise<{ ownLicenseShas: Set<string>; rootHasLicense: boolean }> {
    const root = await this.rootLicences();
    const own = new Set(root.map((licence) => licence.sha));
    for (const licence of licenseFilesOf(entries)) {
      if (own.has(licence.sha)) continue;
      const text = await this.readLicenseText(licence.path);
      if (text === "") continue;
      for (const candidate of root) if ((await candidate.text) === text) own.add(licence.sha);
    }
    return { ownLicenseShas: own, rootHasLicense: root.length > 0 };
  }

  isVendored(path: string): Promise<boolean> {
    return this.inspect(path).then((verdict) => verdict.vendored);
  }

  /**
   * 这个目录的判定和原因；受保护的目录和读不出来的目录按不是算。
   * 调用方已经列过这个目录时把清单传进来，不再列第二次（逐目录展开的模式下列一次就花一次预算）。
   */
  inspect(path: string, entries?: readonly SourceTreeEntry[]): Promise<DirectoryVerdict> {
    if (this.isProtected(path)) return Promise.resolve({ vendored: false, markers: [] });
    let verdict = this.verdicts.get(path);
    if (!verdict) {
      verdict = (entries ? Promise.resolve(entries) : this.index.listDir(path).then((listing) => listing.entries))
        .then(async (listed) => inspectDirectory(listed, await this.ownLicencesOf(listed)))
        .catch(() => ({ vendored: false, markers: [] as UpstreamMarker[] }));
      this.verdicts.set(path, verdict);
    }
    return verdict;
  }

  /** 一个文件最近的第三方祖先目录；没有就返回 null。清单读不出来的目录按不是算，后面读文件时会照常报错。 */
  async vendoredAncestorOf(filePath: string): Promise<string | null> {
    const segments = filePath.split("/").filter(Boolean);
    segments.pop();
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join("/");
      if (await this.isVendored(directory)) return directory;
    }
    return null;
  }
}
