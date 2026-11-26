import { NextRequest, NextResponse } from "next/server";
import { requireSnapshotWriteKey } from "@/lib/api-key-auth";
import { assembleJsonBody, CHUNKED_UPLOAD_ERRORS } from "@/lib/chunked-upload";
import { getDb } from "@/lib/db";
import { ProposalContractError, parseProposal } from "@/lib/client-proposal/contract";
import { loadPublishTarget, ProposalRejection, publishProposal, recordProposalRejection } from "@/lib/client-proposal/publish";
import { scanServer } from "@/lib/privacy-scan";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 审计要记的身份信息。提案还没校验过，所以只能防御性地从原始对象里取。 */
function identityOf(raw: unknown): { revisionSha: string | null; proposalHash: string | null; repositoryId: number | null } {
  const object = typeof raw === "object" && raw !== null ? (raw as { revision?: { sha?: unknown }; proposalHash?: unknown; repository?: { repositoryId?: unknown } }) : {};
  return {
    revisionSha: typeof object.revision?.sha === "string" ? object.revision.sha : null,
    proposalHash: typeof object.proposalHash === "string" ? object.proposalHash : null,
    repositoryId: typeof object.repository?.repositoryId === "number" ? object.repository.repositoryId : null,
  };
}

const CONTRACT_ERROR_STATUS = { invalid_proposal: 400, proposal_hash_mismatch: 400, contract_version_mismatch: 409 } as const;

/**
 * 客户端提案上传（修订稿 §5.6）：Bearer API key 且 scope='snapshot_write'；组织作用域取自 key。
 * 沿用 BYO 快照导入的分块上传（x-import-* 头），每个 key 每小时 10 次完整上传。
 * 这里只做鉴权、组包、校验、隐私复查和错误映射；发布的事务在 lib/client-proposal/publish.ts。
 * 每一次拒绝都写一行审计（client_proposal_rejections），只记机器可读的东西。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const auth = await requireSnapshotWriteKey(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;
  const db = getDb();

  let raw: unknown;
  try {
    raw = await assembleJsonBody(request, identity, { name: "analysis-proposals", limit: 10, windowSeconds: 3600 });
  } catch (error) {
    if (error instanceof Error && error.message === CHUNKED_UPLOAD_ERRORS.rateLimited) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "3600" } });
    }
    if (error instanceof Error && error.message === CHUNKED_UPLOAD_ERRORS.invalidChunk) {
      return NextResponse.json({ error: "invalid_chunk" }, { status: 400 });
    }
    if (error instanceof Error && error.message === CHUNKED_UPLOAD_ERRORS.waiting) {
      return NextResponse.json({ received: true });
    }
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { slug } = await context.params;
  const claimed = identityOf(raw);
  // 产品在确认存在之后才记进审计：找不到产品的请求只留下组织。
  let productId: number | null = null;
  const reject = async (code: string, message: string, status: number, details: unknown, body: Record<string, unknown> = {}) => {
    await recordProposalRejection(db, {
      organizationId: identity.organizationId,
      productId,
      repositoryId: claimed.repositoryId,
      revisionSha: claimed.revisionSha,
      proposalHash: claimed.proposalHash,
      code,
      details,
    });
    return NextResponse.json({ error: code, message, ...(details ? { details } : {}), ...body }, { status });
  };

  try {
    const target = await loadPublishTarget(db, slug, identity.organizationId);
    productId = target.productId;
    let proposal;
    try {
      proposal = parseProposal(raw);
    } catch (error) {
      if (!(error instanceof ProposalContractError)) throw error;
      return await reject(error.code, error.message, CONTRACT_ERROR_STATUS[error.code], error.details ?? null, { minSupportedContractVersion: error.code === "contract_version_mismatch" ? (error.details as { minSupportedContractVersion: string } | undefined)?.minSupportedContractVersion : undefined });
    }
    // 客户端扫过了，服务端再查它做得到的三条规则（代码块、连续片段、补丁特征）。命中说明客户端被改过或版本过旧，不替它剔除。
    const hits = scanServer(raw);
    if (hits.length > 0) {
      return await reject("artifact_contains_source", "the proposal contains text that looks like source code and was not uploaded", 422, null, {
        hits: hits.slice(0, 50).map((hit) => ({ rule: hit.rule, path: hit.path, line: hit.line })),
      });
    }
    const receipt = await publishProposal(db, proposal, target);
    return NextResponse.json(receipt, { status: 200 });
  } catch (error) {
    if (error instanceof ProposalRejection) return await reject(error.code, error.message, error.status, error.details);
    console.error("[client-proposal] publish failed", error);
    return NextResponse.json({ error: "proposal_publish_failed" }, { status: 500 });
  }
}
