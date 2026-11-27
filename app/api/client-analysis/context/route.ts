import { NextRequest, NextResponse } from "next/server";
import { requireSnapshotWriteKey } from "@/lib/api-key-auth";
import { getDb } from "@/lib/db";
import { MAX_SUPPORTED_CONTRACT_VERSIONS, MIN_SUPPORTED_CONTRACT_VERSION, PROPOSAL_CONTRACT_VERSION } from "@/lib/client-proposal/contract";
import { parseSourceRoots } from "@/lib/remote-analysis";

export const runtime = "nodejs";

interface ProductRow {
  id: number | string;
  slug: string;
  name: string;
  analysisExecutor: string;
  sourceRoots: unknown;
  repositoryId: number | string | null;
  provider: string | null;
  host: string | null;
  owner: string | null;
  repositoryName: string | null;
  currentVersionId: number | string | null;
  currentRevisionSha: string | null;
}

/** 库里存坏的源码根目录按没配置算：发布不该因为一行旧数据起不来。 */
function sourceRootsOf(value: unknown): Array<{ path: string; label?: string; role?: string }> {
  try {
    return parseSourceRoots(value);
  } catch {
    return [];
  }
}

/**
 * 客户端分析的上下文（修订稿 §5.2）：`config` 用它验证上传 key（显示连到了哪个组织，让用户确认），
 * `publish` 用它拿契约版本、产品的仓库绑定和账本当前提交（状态判定要用）。
 * 鉴权和上传提案相同：Bearer API key 且 scope='snapshot_write'。
 */
export async function GET(request: NextRequest) {
  const auth = await requireSnapshotWriteKey(request);
  if ("response" in auth) return auth.response;
  const db = getDb();
  const [organizationRows] = (await db.execute("SELECT name FROM organizations WHERE id = ? LIMIT 1", [auth.identity.organizationId])) as unknown as [Array<{ name: string }>, unknown];
  const [rows] = (await db.execute(
    `SELECT p.id, p.slug, p.name, p.analysis_executor AS analysisExecutor, p.source_roots AS sourceRoots,
            r.id AS repositoryId, r.provider, r.host, r.owner, r.name AS repositoryName,
            (SELECT MAX(sv.id) FROM spec_versions sv WHERE sv.repository_id = r.id) AS currentVersionId
     FROM products p LEFT JOIN repositories r ON r.product_id = p.id
     WHERE p.organization_id = ? ORDER BY p.id`,
    [auth.identity.organizationId],
  )) as unknown as [ProductRow[], unknown];
  // 版本号和提交分两次查：窗口函数以外的写法在 8.0 和 9 上都一样。
  const versionIds = rows.map((row) => row.currentVersionId).filter((id): id is number | string => id !== null && id !== undefined);
  const shas = new Map<number, string>();
  if (versionIds.length > 0) {
    const placeholders = versionIds.map(() => "?").join(",");
    const [versionRows] = (await db.execute(`SELECT id, sha FROM spec_versions WHERE id IN (${placeholders})`, versionIds)) as unknown as [Array<{ id: number | string; sha: string }>, unknown];
    for (const version of versionRows) shas.set(Number(version.id), version.sha);
  }
  return NextResponse.json({
    contractVersion: PROPOSAL_CONTRACT_VERSION,
    supportedContractVersions: MAX_SUPPORTED_CONTRACT_VERSIONS,
    minSupportedContractVersion: MIN_SUPPORTED_CONTRACT_VERSION,
    organization: { name: organizationRows[0]?.name ?? "" },
    products: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      analysisExecutor: row.analysisExecutor,
      // 客户端按它把分析限定在产品的源码根目录里；服务端分析用的就是这一份（lib/analysis.ts）。
      sourceRoots: sourceRootsOf(row.sourceRoots),
      currentVersionId: row.currentVersionId == null ? null : Number(row.currentVersionId),
      currentRevisionSha: row.currentVersionId == null ? null : shas.get(Number(row.currentVersionId)) ?? null,
      repository: row.repositoryId == null ? null : {
        repositoryId: Number(row.repositoryId),
        // 纯本地仓库的属主是服务端为了唯一键拼出来的，不是用户的信息，不外传。
        provider: row.provider,
        host: row.host,
        owner: row.provider === "local" ? null : row.owner,
        name: row.provider === "local" ? null : row.repositoryName,
      },
    })),
  });
}
