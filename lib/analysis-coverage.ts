import type { PoolConnection } from "mysql2/promise";
import { evidenceKind } from "./evidence";
import type { AnalysisPartition } from "./remote-analysis";
import type { OpenedRemoteSourceRevision } from "./remote-source-index";

/**
 * B1 覆盖披露（docs/specsight-gap-improvement-plan.md §5.1）。
 * 口径与 scripts/measure-first-analysis.ts 一致，且只有一个口径：
 * 本规格版本对应的完整实现面（evidenceKind 分级的 implementation 文件）。
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
}

/** 全树实现面枚举：BFS listDir，元数据级（不读文件内容），受索引预算约束。 */
export async function enumerateImplementationSurface(index: OpenedRemoteSourceRevision, maxDirs = 1000): Promise<Array<{ path: string; size: number }>> {
  const impl: Array<{ path: string; size: number }> = [];
  const queue: string[] = [""];
  const seenDirs = new Set<string>([""]);
  while (queue.length > 0 && seenDirs.size < maxDirs) {
    const current = queue.shift()!;
    const listing = current === "" ? await index.listRoot() : await index.listDir(current);
    for (const item of listing.entries) {
      if (item.type === "tree") {
        if (!seenDirs.has(item.path)) {
          seenDirs.add(item.path);
          queue.push(item.path);
        }
        continue;
      }
      if (evidenceKind(item.path) === "implementation") impl.push({ path: item.path, size: item.size ?? 0 });
    }
  }
  return impl;
}

/**
 * 覆盖率回执：装配面 = 各分区 slice 文件去重（与 assertEvidence 允许集同源）；
 * 总面 = 索引全树实现面。字节数用装配内容实长（进 prompt 的字节）。
 */
export function computeCoverageReceipt(input: {
  index: OpenedRemoteSourceRevision;
  partitions: AnalysisPartition[];
  maxPartitions: number;
  implSurface?: Array<{ path: string; size: number }>;
}): AnalysisCoverageReceipt {
  const assembledPaths = new Set<string>();
  for (const partition of input.partitions) {
    for (const file of partition.slice.files) assembledPaths.add(file.path);
  }
  const assembled = [...assembledPaths].filter((path) => evidenceKind(path) === "implementation");
  const implBytesAssembled = input.partitions.reduce((total, partition) => {
    return total + partition.sources.reduce((sum, source) => sum + Buffer.byteLength(source.content, "utf8"), 0);
  }, 0);
  const surface = input.implSurface ?? [];
  const implBytesTotal = surface.reduce((total, file) => total + file.size, 0);
  return {
    implFilesAssembled: assembled.length,
    implFilesTotal: surface.length,
    implBytesAssembled,
    implBytesTotal,
    coverageRatio: implBytesTotal === 0 ? 0 : implBytesAssembled / implBytesTotal,
    partitionsUsed: input.partitions.length,
    partitionsCapped: input.partitions.length >= input.maxPartitions,
  };
}

/** 触顶判定：趟数到达上限即视为可能未覆盖全部实现面，展示层必须显式警示。 */
export function isCoverageCapped(receipt: AnalysisCoverageReceipt, maxPartitions: number) {
  return receipt.partitionsUsed >= maxPartitions;
}

/** 回执与规格版本同事务落库（append-only，历史版本可回溯当时覆盖率）。 */
export async function saveCoverageReceipt(connection: Pick<PoolConnection, "execute">, specVersionId: number, receipt: AnalysisCoverageReceipt) {
  await connection.execute(
    `INSERT INTO analysis_coverage_receipts
      (spec_version_id, impl_files_assembled, impl_files_total, impl_bytes_assembled, impl_bytes_total, coverage_ratio, partitions_used, partitions_capped)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [specVersionId, receipt.implFilesAssembled, receipt.implFilesTotal, receipt.implBytesAssembled, receipt.implBytesTotal, receipt.coverageRatio, receipt.partitionsUsed, receipt.partitionsCapped ? 1 : 0],
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
