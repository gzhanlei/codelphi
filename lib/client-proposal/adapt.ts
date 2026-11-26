/**
 * 提案 → 合并入口要的输入（修订稿 §4.4 的适配层）。全是纯函数：不读库、不读环境。
 *
 * 合并入口（saveResultInTransaction）要一个 run、一份变更、一份覆盖率回执，和托管分析拿到的同形。
 * 这里把提案翻译成这三样，外加版本的来源信息。
 */
import type { RunContext } from "../analysis";
import type { AnalysisCoverageReceipt } from "../analysis-coverage";
import { CLIENT_UPLOAD_TRIGGER } from "../analysis-executor";
import type { ChangeContext } from "../code-hosting/types";
import type { Proposal } from "./contract";

/** 拿不到补丁文本时托管路径填的占位串（lib/github-source.ts 用的是同一个）。提案的文件项没有补丁，填它。 */
export const PLACEHOLDER_PATCH = "(binary or patch unavailable)";

/** 服务端在发布事务里定下来的身份：run 是刚插入的那一行，仓库是锁定并核对过的那一行。 */
export interface PublishIdentity {
  runId: number;
  repositoryId: number;
  productId: number;
  organizationId: number;
  productSlug: string;
  productName: string;
  owner: string;
  name: string;
  provider: "github" | "gitee" | "gitlab" | "gitea";
}

/** 三类功能的计数（修订稿 §4.5）。第 1 期只有全量：后两类都是 0 之外的情况要到增量才出现。 */
export interface VerificationCounts {
  reanalyzed: number;
  deterministicallyCarried: number;
  clientDeclaredUnaffected: number;
}

/** 一版的来源信息，两组分开（修订稿 §6）。托管的版本不写这一列，空的就是托管。 */
export interface VersionProvenance {
  /** 服务端确认的事实。 */
  server: {
    executor: "client";
    receivedAt: string;
    specVersionId: number;
    /** 账本登记在这个提交上。服务端没法核对客户端是不是真的分析了它，但「登记在这个提交上」是服务端的事实。 */
    revisionSha: string;
    contractVersion: string;
    verification: {
      scope: "file_level_paths";
      reanalyzed: number;
      deterministicallyCarried: number;
      clientDeclaredUnaffected: number;
    };
  };
  /** 客户端的说法，原样记录。任何地方都不把它当成已验证。 */
  client: {
    model: string;
    clientVersion: string;
    pipelineVersion: string;
    promptVersion: string;
    impactRulesVersion: string;
    analyzedAt: string;
  };
}

export function runContextOf(proposal: Proposal, identity: PublishIdentity): RunContext {
  const base = proposal.base;
  const { runId, ...repository } = identity;
  return {
    id: runId,
    ...repository,
    beforeSha: base?.sha ?? null,
    afterSha: proposal.revision.sha,
    baseSpecVersionId: base?.specVersionId ?? null,
    // 合并入口靠「有没有基线版本号」决定按哪一版合并；带上时间只是沿用 RunContext 原有的约定。
    baseCapturedAt: base ? new Date() : null,
    connectionId: null,
    accountId: identity.organizationId,
    analyzeMode: proposal.mode,
    outputLanguage: proposal.language,
    triggerType: CLIENT_UPLOAD_TRIGGER,
    analysisExecutor: "client",
  };
}

/** 发布页的链接。只在仓库有托管主机时才有；纯本地的仓库没有可以点的地方。 */
export function releaseUrlOf(proposal: Proposal): string {
  const { provider, host, owner, name } = proposal.repository;
  if (host === null || owner === null) return "";
  if (provider === "gitlab") return `https://${host}/${owner}/${name}/-/commit/${proposal.revision.sha}`;
  return `https://${host}/${owner}/${name}/commit/${proposal.revision.sha}`;
}

/** 变更窗口：路径、状态、行为标志和行号区间都是客户端在本地算好交上来的，没有补丁文本。 */
export function changeOf(proposal: Proposal): ChangeContext {
  const files = proposal.window?.files ?? [];
  return {
    message: proposal.revision.title,
    committedAt: proposal.revision.committedAt,
    url: releaseUrlOf(proposal),
    files: files.map((file) => ({ path: file.path, status: file.status, patch: PLACEHOLDER_PATCH, hunks: file.hunks })),
    behavioralPaths: new Set(files.filter((file) => file.behavioral).map((file) => file.path)),
  };
}

/** 覆盖率回执。比例不上传：服务端用整数计数算，和托管路径是同一个式子（lib/analysis-coverage.ts）。 */
export function coverageOf(proposal: Proposal): AnalysisCoverageReceipt | undefined {
  const receipt = proposal.coverage;
  if (!receipt) return undefined;
  return { ...receipt, coverageRatio: receipt.implBytesTotal === 0 ? 0 : receipt.implBytesAssembled / receipt.implBytesTotal };
}

export function provenanceOf(proposal: Proposal, server: { receivedAt: string; specVersionId: number; counts: VerificationCounts }): VersionProvenance {
  return {
    server: {
      executor: "client",
      receivedAt: server.receivedAt,
      specVersionId: server.specVersionId,
      revisionSha: proposal.revision.sha,
      contractVersion: proposal.contractVersion,
      verification: { scope: "file_level_paths", ...server.counts },
    },
    client: {
      model: proposal.client.model,
      clientVersion: proposal.client.version,
      pipelineVersion: proposal.client.pipelineVersion,
      promptVersion: proposal.client.promptVersion,
      impactRulesVersion: proposal.client.impactRulesVersion,
      analyzedAt: proposal.client.analyzedAt,
    },
  };
}
