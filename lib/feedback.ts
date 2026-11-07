import { z } from "zod";
import { getDb } from "./db";
import { resolveGitHubToken } from "./github-access";
import { getProductDetails } from "./product-details";
import type { SessionUser } from "./types";
import type { Organization } from "./organizations";

export interface FeedbackReport {
  id: number;
  organizationId: number;
  organizationName: string;
  productId: number;
  productName: string;
  repositoryFullName: string;
  revision: string;
  errorMessage: string;
  architectureError: string | null;
  status: string;
  githubIssueUrl: string | null;
  submissionError: string | null;
  createdAt: Date;
}

function mapReport(row: FeedbackReport & { organizationName: string; productName: string }) {
  return row;
}

function failureMessage(details: NonNullable<Awaited<ReturnType<typeof getProductDetails>>>) {
  return details.latestRun?.status === "failed" ? details.latestRun.errorMessage : undefined;
}

function revisionFor(details: NonNullable<Awaited<ReturnType<typeof getProductDetails>>>) {
  return details.releases[0]?.sha ?? "unknown";
}

function repositoryNameFor(details: NonNullable<Awaited<ReturnType<typeof getProductDetails>>>) {
  if (!details.repository) throw new Error("product_repository_missing");
  return `${details.repository.owner}/${details.repository.name}`;
}

function feedbackContext(details: NonNullable<Awaited<ReturnType<typeof getProductDetails>>>) {
  const errorMessage = failureMessage(details);
  if (!errorMessage) throw new Error("no_failed_analysis");
  return {
    errorMessage,
    revision: revisionFor(details),
    repositoryFullName: repositoryNameFor(details),
  };
}

async function existingFeedbackId(productId: number, revision: string, errorMessage: string) {
  const [rows] = await getDb().execute(
    "SELECT id FROM feedback_reports WHERE product_id = ? AND revision = ? AND error_message = ? ORDER BY id DESC LIMIT 1",
    [productId, revision, errorMessage],
  );
  return (rows as Array<{ id: number }>)[0]?.id;
}

async function insertFeedbackReport(input: { user: SessionUser; organization: Organization; details: NonNullable<Awaited<ReturnType<typeof getProductDetails>>>; errorMessage: string; revision: string; repositoryFullName: string }) {
  const { user, organization, details, errorMessage, revision, repositoryFullName } = input;
  const [result] = await getDb().execute(
    `INSERT INTO feedback_reports
      (organization_id, product_id, reporter_user_id, repository_full_name, revision, error_message, architecture_error, status)
     SELECT ?, ?, u.id, ?, ?, ?, ?, 'new' FROM users u WHERE u.chandler_sub = ?`,
    [organization.id, details.product.id, repositoryFullName, revision, errorMessage, null, user.sub],
  );
  return Number((result as { insertId: number }).insertId);
}

export async function createFeedbackReport(input: {
  user: SessionUser;
  organization: Organization;
  details: NonNullable<Awaited<ReturnType<typeof getProductDetails>>>;
}) {
  const { user, organization, details } = input;
  const context = feedbackContext(details);
  const existing = await existingFeedbackId(details.product.id, context.revision, context.errorMessage);
  if (existing) return existing;
  return insertFeedbackReport({ user, organization, details, ...context });
}

export async function listFeedbackReports(): Promise<FeedbackReport[]> {
  const [rows] = await getDb().execute(
    `SELECT f.id, f.organization_id AS organizationId, o.name AS organizationName,
            f.product_id AS productId, p.name AS productName, f.repository_full_name AS repositoryFullName,
            f.revision, f.error_message AS errorMessage, f.architecture_error AS architectureError,
            f.status, f.github_issue_url AS githubIssueUrl, f.submission_error AS submissionError, f.created_at AS createdAt
     FROM feedback_reports f
     JOIN organizations o ON o.id = f.organization_id
     JOIN products p ON p.id = f.product_id
     ORDER BY f.created_at DESC LIMIT 100`,
  );
  return (rows as FeedbackReport[]).map(mapReport);
}

export async function getFeedbackReport(id: number): Promise<FeedbackReport | null> {
  const [rows] = await getDb().execute(
    `SELECT f.id, f.organization_id AS organizationId, o.name AS organizationName,
            f.product_id AS productId, p.name AS productName, f.repository_full_name AS repositoryFullName,
            f.revision, f.error_message AS errorMessage, f.architecture_error AS architectureError,
            f.status, f.github_issue_url AS githubIssueUrl, f.submission_error AS submissionError, f.created_at AS createdAt
     FROM feedback_reports f JOIN organizations o ON o.id = f.organization_id
     JOIN products p ON p.id = f.product_id WHERE f.id = ? LIMIT 1`,
    [id],
  );
  const row = (rows as FeedbackReport[])[0];
  return row ? mapReport(row) : null;
}

export function feedbackIssueBody(report: FeedbackReport) {
  const architecture = report.architectureError ? `\n\n### Architecture Error\n\`\`\`text\n${report.architectureError}\n\`\`\`` : "";
  return `## CoDelphi 自动分析失败反馈\n\n- Product: ${report.productName}\n- Repository: ${report.repositoryFullName}\n- Revision: ${report.revision}\n- Organization: ${report.organizationName}\n- Report ID: ${report.id}\n\n### Analysis Error\n\`\`\`text\n${report.errorMessage}\n\`\`\`${architecture}`;
}

const issueSchema = z.object({ html_url: z.string().url() });

async function issueToken(explicitToken?: string) {
  if (explicitToken) return explicitToken;
  if (process.env.GITHUB_TOKEN) return resolveGitHubToken();
  return resolveGitHubToken({ connectionId: 1, organizationId: 1 });
}

function issueCreationMessage(status: number) {
  if (status === 403) return "GitHub issue creation failed: 403 (凭据缺少 issues:write 权限；当前 GitHub App 的 contents:read 不能创建 Issue)";
  return `GitHub issue creation failed: ${status}`;
}

async function createGithubIssue(report: FeedbackReport, token: string, fetcher: typeof fetch) {
  const response = await fetcher("https://api.github.com/repos/gzhanlei/codelphi/issues", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "codelphi-feedback",
    },
    body: JSON.stringify({
      title: `[CoDelphi] ${report.productName} 分析失败反馈`,
      body: feedbackIssueBody(report),
      labels: ["feedback", "analysis-failure"],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(issueCreationMessage(response.status));
  return issueSchema.parse(await response.json()).html_url;
}

export async function submitFeedbackToGitHub(id: number, options: { token?: string; fetcher?: typeof fetch } = {}) {
  const report = await getFeedbackReport(id);
  if (!report) throw new Error("feedback_not_found");
  if (report.githubIssueUrl) return report.githubIssueUrl;
  try {
    const fetcher = options.fetcher === undefined ? fetch : options.fetcher;
    const issueUrl = await createGithubIssue(report, await issueToken(options.token), fetcher);
    await getDb().execute("UPDATE feedback_reports SET status = 'submitted', github_issue_url = ?, submission_error = NULL WHERE id = ?", [issueUrl, id]);
    return issueUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub issue creation failed";
    await getDb().execute("UPDATE feedback_reports SET status = 'failed', submission_error = ? WHERE id = ?", [message, id]);
    throw error;
  }
}
