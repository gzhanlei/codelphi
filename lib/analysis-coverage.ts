import type { PoolConnection } from "mysql2/promise";
import { isImplementationSurfaceFile } from "./evidence";
import { isModelContextFile } from "./analysis-target";
import type { AnalysisPartition } from "./remote-analysis";
import type { OpenedRemoteSourceRevision, SourceScopeRoot, SourceTreeEntry } from "./remote-source-index";
import { VendoredDirectoryDetector } from "./slice-planner/vendored-directory";
import { ToolingDirectories } from "./slice-planner/tooling-directory";
import type { SliceExclusion } from "./slice-planner/types";

/**
 * B1 覆盖披露（docs/specsight-gap-improvement-plan.md §5.1）。
 * 口径与 scripts/measure-first-analysis.ts 一致，且只有一个口径：
 * 本规格版本对应的完整实现面（evidenceKind 分级的 implementation 文件）。
 * 2026-11-25 起另外排除迁移脚本（它已移出分析目标）；那个脚本量的是当时的历史口径，没有跟着改。
 * run 类型（首分析 / 增量 / RC2-carry）只作诊断元数据，不参与门槛解释。
 */

export interface AnalysisCoverageReceipt {
  implFilesAssembled: number;
  implFilesTotal: number;
  implBytesAssembled: number;
  implBytesTotal: number;
  coverageRatio: number;
  partitionsUsed: number;
  partitionsCapped: boolean;
  /** W0-9 评审采纳：diff 覆盖口径——必选 ≠ 全覆盖，遗漏必须可见（null = 无窗口 diff 或 058 前历史版本）。 */
  diffTotalPaths: number | null;
  diffSelectedPaths: number | null;
  diffOmittedPaths: number | null;
  /**
   * Task 14 · inventory 编排路径的主覆盖区间遗漏（唯一行数，evaluateInventoryCoverage
   * 的 primaryCoverage 口径）。旧分区/继承回执为 null：sourceCoverage 完整性判定对
   * 旧回执保持历史语义；新路径 complete 必须要求该值为零（设计 §6.3）。
   */
  primaryRangesOmitted?: number | null;
}

/** 与索引 assertAllowed("list") 同构的目录可见性：scope 内、scope 根祖先、或无 scope 配置。 */
function isDirWithinScope(path: string, scopeRoots: OpenedRemoteSourceRevision["scopeRoots"]): boolean {
  if (scopeRoots.length === 0) return true;
  return scopeRoots.some((scope) => scope.path === "" || path === scope.path || path.startsWith(`${scope.path}/`) || scope.path.startsWith(`${path}/`));
}

/** 文件实现面分母只含 scope 内条目：read 侧守卫对非 scope 后代一律拒绝。 */
function isFileWithinScope(path: string, scopeRoots: OpenedRemoteSourceRevision["scopeRoots"]): boolean {
  if (scopeRoots.length === 0) return true;
  return scopeRoots.some((scope) => scope.path === "" || path === scope.path || path.startsWith(`${scope.path}/`));
}

/**
 * 全树实现面枚举：BFS listDir，元数据级（不读文件内容；只有工具目录的入口要看一眼启动文件），受索引预算约束。
 * 装着一份拷进来的上游项目的目录整棵跳过，开发工具目录只算启动文件点到的入口——和规划器问的是同一套判定，
 * 两边对同一个目录的答案一致。
 */
export async function enumerateImplementationSurface(index: OpenedRemoteSourceRevision, maxDirs = Number.POSITIVE_INFINITY, scopeRoots: SourceScopeRoot[] = index.scopeRoots ?? []): Promise<Array<{ path: string; size: number }>> {
  const detector = new VendoredDirectoryDetector(index, scopeRoots);
  const tooling = new ToolingDirectories(index, scopeRoots);
  const impl: Array<{ path: string; size: number }> = [];
  const queue: Array<{ path: string; parentEntries?: SourceTreeEntry[]; toolingDirectory: string | null }> = [{ path: "", toolingDirectory: null }];
  const seenDirs = new Set<string>([""]);
  while (queue.length > 0 && seenDirs.size < maxDirs) {
    const queued = queue.shift()!;
    const current = queued.path;
    const listing = current === "" ? await index.listRoot() : await index.listDir(current);
    if (current !== "" && (await detector.isVendored(current))) continue;
    let toolingDirectory = queued.toolingDirectory;
    if (toolingDirectory === null && tooling.isToolingDirectory(current, queued.parentEntries ?? []) && (await tooling.appliesWithin(tooling.scopeRootOf(current)))) toolingDirectory = current;
    const entryPoints = toolingDirectory === null ? null : await tooling.entryPointsOf(toolingDirectory, toolingDirectory === current ? queued.parentEntries : undefined);
    for (const item of listing.entries) {
      // prune 条目（third_party / 构建产物 / 二进制等）不进实现面；scope 边界须在每一层
      // 自查——索引只在根层把 scope 外条目标记 pruned，scope 根祖先目录内的 scope 外
      // 兄弟子树（如 app/src/test 对 scope app/src/main）不会被 prune，但 listDir/read
      // 的 assertAllowed 照样抛 path_outside_product_scope（run 80：整个 run 因此失败）。
      if (item.pruned) continue;
      if (item.type === "tree") {
        if (!isDirWithinScope(item.path, scopeRoots)) continue;
        if (!seenDirs.has(item.path)) {
          seenDirs.add(item.path);
          queue.push({ path: item.path, parentEntries: listing.entries, toolingDirectory });
        }
        continue;
      }
      if (!isFileWithinScope(item.path, scopeRoots) || !isImplementationSurfaceFile(item.path)) continue;
      // 工具目录里只有启动文件点到的入口算实现面。
      if (toolingDirectory === null || entryPoints!.has(item.path)) impl.push({ path: item.path, size: item.size ?? 0 });
    }
  }
  return impl;
}

/**
 * 只 stat 必选路径，不列任何目录：增量分析的实现面限于 diff 与受影响证据。
 * 规划器排除的路径（落在拷进来的上游项目里的必选文件）由调用方从 paths 里去掉——列目录判断的事规划器已经做过。
 */
export async function enumerateRequiredImplementationSurface(index: OpenedRemoteSourceRevision, paths: readonly string[]): Promise<Array<{ path: string; size: number }>> {
  const surface: Array<{ path: string; size: number }> = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!isImplementationSurfaceFile(path)) continue;
    const stat = await index.statPath(path);
    if (stat) surface.push({ path, size: stat.byteSize });
  }
  return surface;
}

/**
 * 覆盖率回执：装配面 = 各分区 slice 文件去重（与 assertEvidence 允许集同源）；
 * 总面 = 全量时的全树实现面，或定向增量时的 requiredPaths 实现面。字节数用装配内容实长。
 */
function rawSourceBytes(content: string): number {
  const lines = content.split("\n");
  const matches = lines.map((line) => /^\d+: (.*)$/.exec(line));
  const numbered = lines.every((line, index) => matches[index] || (index === lines.length - 1 && line === ""));
  if (!numbered) return Buffer.byteLength(content, "utf8");
  return Buffer.byteLength(lines.map((line, index) => matches[index]?.[1] ?? line).join("\n"), "utf8");
}

export function computeCoverageReceipt(input: {
  index: OpenedRemoteSourceRevision;
  partitions: AnalysisPartition[];
  implSurface?: Array<{ path: string; size: number }>;
  /** W0-9 评审采纳：窗口 diff 路径清单（diff 覆盖率口径）。 */
  diffPaths?: readonly string[];
  /** 分区被 ANALYSIS_MAX_PARTITIONS 截断（remote-analysis 返回的披露信号）。 */
  partitionsCapped?: boolean;
  /** 规划器排除在分析之外的路径：落在拷进来的上游项目里的必选文件、内容重复的文件…… */
  excluded?: readonly SliceExclusion[];
}): AnalysisCoverageReceipt {
  const assembledPaths = new Set<string>();
  for (const partition of input.partitions) {
    for (const file of partition.slice.files) assembledPaths.add(file.path);
  }
  const assembledAll = assembledPaths;
  const assembled = [...assembledPaths].filter(isImplementationSurfaceFile);
  const bytesByPath = new Map<string, number>();
  for (const partition of input.partitions) {
    for (const source of partition.sources) bytesByPath.set(source.path, rawSourceBytes(source.content));
  }
  const implBytesAssembled = [...bytesByPath.values()].reduce((total, size) => total + size, 0);
  const surface = input.implSurface?.length
    ? input.implSurface
    : assembled.map((path) => ({ path, size: bytesByPath.get(path) ?? 0 }));
  const implBytesTotal = surface.reduce((total, file) => total + file.size, 0);
  // W0-9 评审采纳：diff 必选 ≠ diff 全覆盖——diff 面自身的入选/遗漏单独计数，
  // 6 分区帽或不可读导致的遗漏必须可见（「优先选择」不等于「实际覆盖」）。
  // 迁移脚本已移出分析目标：它既不会被装配，也不该被算成遗漏。
  // 2026-11-27 起不只是迁移脚本：所有不在分析目标里的文件都既不会被装配，也不该被算成遗漏。
  // 规划器排除的文件同理：它不会被装配，可它也不是遗漏。
  const excludedPaths = new Set((input.excluded ?? []).map((exclusion) => exclusion.path));
  const diffPaths = (input.diffPaths ?? []).filter((path) => isModelContextFile(path) && !excludedPaths.has(path));
  const diffSelectedPaths = new Set<string>();
  for (const path of new Set(diffPaths)) {
    if (assembledAll.has(path)) diffSelectedPaths.add(path);
  }
  const diffTotal = diffSelectedPaths.size + [...new Set(diffPaths)].filter((path) => !assembledAll.has(path)).length;
  return {
    implFilesAssembled: assembled.length,
    implFilesTotal: surface.length,
    implBytesAssembled,
    implBytesTotal,
    coverageRatio: implBytesTotal === 0 ? 0 : implBytesAssembled / implBytesTotal,
    partitionsUsed: input.partitions.length,
    partitionsCapped: input.partitionsCapped ?? false,
    diffTotalPaths: diffPaths.length > 0 ? diffTotal : null,
    diffSelectedPaths: diffPaths.length > 0 ? diffSelectedPaths.size : null,
    diffOmittedPaths: diffPaths.length > 0 ? diffTotal - diffSelectedPaths.size : null,
    // Task 14：主覆盖区间遗漏是 inventory 编排的口径，旧分区回执恒为 null（历史语义不变）
    primaryRangesOmitted: null,
  };
}

/** 回执与规格版本同事务落库（append-only，历史版本可回溯当时覆盖率）。 */
export async function saveCoverageReceipt(connection: Pick<PoolConnection, "execute">, specVersionId: number, receipt: AnalysisCoverageReceipt) {
  await connection.execute(
    `INSERT INTO analysis_coverage_receipts
      (spec_version_id, impl_files_assembled, impl_files_total, impl_bytes_assembled, impl_bytes_total, coverage_ratio, partitions_used, partitions_capped, diff_total_paths, diff_selected_paths, diff_omitted_paths)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [specVersionId, receipt.implFilesAssembled, receipt.implFilesTotal, receipt.implBytesAssembled, receipt.implBytesTotal, receipt.coverageRatio, receipt.partitionsUsed, receipt.partitionsCapped ? 1 : 0, receipt.diffTotalPaths, receipt.diffSelectedPaths, receipt.diffOmittedPaths],
  );
}

export interface CoverageReceiptRow {
  specVersionId: number;
  implFilesAssembled: number;
  implFilesTotal: number;
  implBytesAssembled: number;
  implBytesTotal: number;
  coverageRatio: number;
  partitionsUsed: number;
  partitionsCapped: boolean;
}

/** 读取某规格版本的覆盖率回执（无回执返回 null：migration 054 之前的历史版本）。 */
export async function loadCoverageReceipt(execute: (sql: string, params?: unknown[]) => Promise<unknown>, specVersionId: number): Promise<CoverageReceiptRow | null> {
  const result = await execute(
    `SELECT spec_version_id AS specVersionId, impl_files_assembled AS implFilesAssembled, impl_files_total AS implFilesTotal,
            impl_bytes_assembled AS implBytesAssembled, impl_bytes_total AS implBytesTotal,
            coverage_ratio AS coverageRatio, partitions_used AS partitionsUsed, partitions_capped AS partitionsCapped
     FROM analysis_coverage_receipts WHERE spec_version_id = ?`,
    [specVersionId],
  );
  const rows = (Array.isArray(result) ? result[0] : result) as unknown as Array<CoverageReceiptRow>;
  return rows?.[0] ?? null;
}

/**
 * 沿版本链向上取最近有效回执（BM-10 修复，生产 run 220 根因：写侧继承只查上一版，
 * 上一版是回填快照或本身就是沿用版本时无有效回执 → 落合成零回执 → 账本 source_coverage
 * 误报 failed；读侧本就沿链跳过零回执，写侧与之同构）。有效 = implFilesTotal > 0
 * （合成零回执的 implFilesTotal = 0，视为无）；最多回看 maxVersions 版，全空返回 null。
 */
export async function loadInheritedCoverageReceipt(
  execute: (sql: string, params: unknown[]) => Promise<unknown>,
  repositoryId: number,
  beforeSpecVersionId: number,
  maxVersions = 10,
): Promise<{ receipt: AnalysisCoverageReceipt; fromSpecVersionId: number; versionsScanned: number } | null> {
  const versionsResult = await execute(
    `SELECT id FROM spec_versions WHERE repository_id = ? AND id < ? ORDER BY id DESC LIMIT ${maxVersions}`,
    [repositoryId, beforeSpecVersionId],
  );
  const versionRows = (Array.isArray(versionsResult) ? versionsResult[0] : versionsResult) as unknown as Array<{ id: number | string }>;
  const chain = Array.isArray(versionRows) ? versionRows : [];
  let scanned = 0;
  for (const row of chain) {
    const versionId = Number(row.id);
    if (!Number.isFinite(versionId)) continue;
    scanned += 1;
    const receiptResult = await execute(
      `SELECT impl_files_assembled AS implFilesAssembled, impl_files_total AS implFilesTotal,
              impl_bytes_assembled AS implBytesAssembled, impl_bytes_total AS implBytesTotal,
              coverage_ratio AS coverageRatio, partitions_used AS partitionsUsed, partitions_capped AS partitionsCapped,
              diff_total_paths AS diffTotalPaths, diff_selected_paths AS diffSelectedPaths, diff_omitted_paths AS diffOmittedPaths
       FROM analysis_coverage_receipts WHERE spec_version_id = ?`,
      [versionId],
    );
    const receiptRows = (Array.isArray(receiptResult) ? receiptResult[0] : receiptResult) as unknown as Array<AnalysisCoverageReceipt>;
    const receipt = receiptRows?.[0];
    if (receipt && Number(receipt.implFilesTotal) > 0) {
      return {
        receipt: {
          ...receipt,
          implFilesAssembled: Number(receipt.implFilesAssembled),
          implFilesTotal: Number(receipt.implFilesTotal),
          implBytesAssembled: Number(receipt.implBytesAssembled),
          implBytesTotal: Number(receipt.implBytesTotal),
          coverageRatio: Number(receipt.coverageRatio),
          partitionsUsed: Number(receipt.partitionsUsed),
          partitionsCapped: Boolean(receipt.partitionsCapped),
          diffTotalPaths: receipt.diffTotalPaths === null || receipt.diffTotalPaths === undefined ? null : Number(receipt.diffTotalPaths),
          diffSelectedPaths: receipt.diffSelectedPaths === null || receipt.diffSelectedPaths === undefined ? null : Number(receipt.diffSelectedPaths),
          diffOmittedPaths: receipt.diffOmittedPaths === null || receipt.diffOmittedPaths === undefined ? null : Number(receipt.diffOmittedPaths),
        },
        fromSpecVersionId: versionId,
        versionsScanned: scanned,
      };
    }
  }
  return null;
}
