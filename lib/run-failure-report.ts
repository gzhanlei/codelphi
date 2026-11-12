import { getDb } from "./db";
import { appUrl } from "./env";
import { explainRunFailure, runFailureSignature } from "./run-failure-explain";

/**
 * 分析失败的 GitHub issue 自动上报（2026-11-12 用户裁决）：页面只给人话
 * （lib/run-failure-explain.ts），技术现场（error_message 原文）去 GitHub——
 * 堆栈、产品页、run 身份一次带齐，排障不再依赖登服务器查库。
 *
 * 通道纪律：
 * - GITHUB_ISSUE_TOKEN 配置才启用（仓库 GITHUB_ISSUE_REPO，默认 gzhanlei/codelphi）；
 *   未配置只记一条日志，绝不影响 run 失败处理本身。
 * - 去重：同类同因（签名=类别+错误首因，见 runFailureSignature）共用一个 open issue，
 *   后续失败追评而不是新建——step_order 事故那种全量连挂不会刷屏。
 * - 上报失败只 console.warn，自吞噬：监控通道自身故障不进入业务失败路径。
 */

const GITHUB_API = "https://api.github.com";
export const ANALYSIS_FAILURE_LABEL = "analysis-failure";

export interface ReportContext {
  runId: number;
  errorMessage: string;
}

interface RunFacts {
  triggerType: string | null;
  beforeSha: string | null;
  afterSha: string | null;
  pagePath: string;
}

function issueRepo(): string {
  return (process.env.GITHUB_ISSUE_REPO ?? "gzhanlei/codelphi").replace(/\/$/, "");
}

function issueToken(): string | null {
  return process.env.GITHUB_ISSUE_TOKEN?.trim() || null;
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${issueToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function loadRunFacts(runId: number): Promise<RunFacts | null> {
  const [rows] = await getDb().execute(
    `SELECT r.trigger_type AS triggerType, r.before_sha AS beforeSha, r.after_sha AS afterSha,
            p.id AS productId, o.slug AS orgSlug, p.slug AS productSlug
     FROM analysis_runs r
     JOIN repositories repo ON repo.id = r.repository_id
     JOIN products p ON p.id = repo.product_id
     JOIN organizations o ON o.id = p.organization_id
     WHERE r.id = ? LIMIT 1`,
    [runId],
  );
  const row = (rows as Array<{ triggerType: string | null; beforeSha: string | null; afterSha: string | null; orgSlug: string; productSlug: string }>)[0];
  if (!row) return null;
  return {
    triggerType: row.triggerType,
    beforeSha: row.beforeSha,
    afterSha: row.afterSha,
    pagePath: `/products/${row.orgSlug}/${row.productSlug}`,
  };
}

function issueTitle(signature: string): string {
  return `[auto-analysis] ${signature}`;
}

function issueBody(facts: RunFacts, signature: string, errorMessage: string, runId: number): string {
  const { technicalClass } = explainRunFailure(errorMessage);
  return [
    "## 自动上报的分析失败",
    "",
    `- 产品页：${appUrl()}${facts.pagePath}`,
    `- Run：#${runId}（trigger=${facts.triggerType ?? "?"}，${facts.beforeSha?.slice(0, 8) ?? "?"} → ${facts.afterSha?.slice(0, 8) ?? "?"}）`,
    `- 错误类别：${technicalClass}（签名 \`${signature}\`）`,
    "",
    "<details><summary>技术错误信息（analysis_runs.error_message 原文）</summary>",
    "",
    "```",
    errorMessage.slice(0, 4_000),
    "```",
    "",
    "</details>",
    "",
    "> 由失败处理链路自动创建；同类同因的失败会追评到本 issue，不再新建。",
  ].join("\n");
}

async function findOpenIssueBySignature(signature: string): Promise<number | null> {
  const { status, body } = await fetchJson(
    `${GITHUB_API}/repos/${issueRepo()}/issues?labels=${ANALYSIS_FAILURE_LABEL}&state=open&per_page=100`,
    { method: "GET" },
  );
  if (status !== 200 || !Array.isArray(body)) return null;
  const title = issueTitle(signature);
  const match = (body as Array<{ number: number; title: string }>).find((issue) => issue.title === title);
  return match?.number ?? null;
}

async function createIssue(facts: RunFacts, signature: string, errorMessage: string, runId: number): Promise<void> {
  const { status, body } = await fetchJson(`${GITHUB_API}/repos/${issueRepo()}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: issueTitle(signature),
      body: issueBody(facts, signature, errorMessage, runId),
      labels: [ANALYSIS_FAILURE_LABEL],
    }),
  });
  if (status < 200 || status >= 300) {
    throw new Error(`github issue create failed: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  }
}

async function commentOnIssue(issueNumber: number, facts: RunFacts): Promise<void> {
  const { status, body } = await fetchJson(`${GITHUB_API}/repos/${issueRepo()}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body: [
        `Run 再次失败（trigger=${facts.triggerType ?? "?"}，${facts.beforeSha?.slice(0, 8) ?? "?"} → ${facts.afterSha?.slice(0, 8) ?? "?"}）`,
      ].join("\n"),
    }),
  });
  if (status < 200 || status >= 300) {
    throw new Error(`github issue comment failed: ${status} ${JSON.stringify(body).slice(0, 300)}`);
  }
}

/** 失败处理链路调用；自身失败只告警不抛出。未配置 token 时静默跳过（记一条日志）。 */
export async function reportRunFailureToGithub(context: ReportContext): Promise<void> {
  try {
    if (!issueToken()) {
      console.log("[analysis] github issue reporting skipped: GITHUB_ISSUE_TOKEN not configured");
      return;
    }
    const explanation = explainRunFailure(context.errorMessage);
    if (!explanation.reportable) return;
    const facts = await loadRunFacts(context.runId);
    if (!facts) {
      console.warn("[analysis] github issue reporting skipped: run facts not found", { runId: context.runId });
      return;
    }
    const signature = runFailureSignature(context.errorMessage);
    const issueNumber = await findOpenIssueBySignature(signature);
    if (issueNumber) {
      await commentOnIssue(issueNumber, facts);
      console.log("[analysis] failure appended to existing github issue", { runId: context.runId, issueNumber, signature });
    } else {
      await createIssue(facts, signature, context.errorMessage, context.runId);
      console.log("[analysis] failure reported as new github issue", { runId: context.runId, signature });
    }
  } catch (error) {
    console.warn("[analysis] github issue reporting failed", {
      runId: context.runId,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    });
  }
}
