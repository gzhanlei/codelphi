import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisFeedbackButton, handleAnalysisFeedback } from "../components/analysis-feedback-button";
import { FeedbackIssueButton, handleGithubIssue } from "../components/feedback-issue-button";
import { submitGithubIssue, submitProductFeedback } from "../lib/feedback-client";
import { createFeedbackReport, feedbackIssueBody, listFeedbackReports, submitFeedbackToGitHub } from "../lib/feedback";
import { isPlatformAdmin } from "../lib/platform-admin";

const execute = vi.fn();
vi.mock("../lib/db", () => ({ getDb: () => ({ execute }) }));
vi.mock("../lib/feedback-client", () => ({ submitProductFeedback: vi.fn(), submitGithubIssue: vi.fn() }));

const details = {
  product: { id: 3, slug: "chandler", name: "Chandler", description: "test", descriptionSource: "manual", descriptionEvidence: null },
  repository: { owner: "gzhanlei", name: "workmembership", defaultBranch: "main" },
  latestRun: { status: "failed", errorMessage: "No architecture components detected" },
  features: [],
  scenarios: [],
  releases: [{ id: 8, title: "v1", summary: "", sha: "abcdef1234567890", url: "", committedAt: new Date(), specVersionId: 8 }],
  changes: [],
  behaviorChanges: [],
  foldedChanges: [],
  driftCount: 0,
  coverage: null,
  architecture: undefined,
  regressionTasks: [],
  releaseTotal: 0,
  completeness: null,
} as NonNullable<Awaited<ReturnType<typeof import("../lib/product-details").getProductDetails>>>;

import { analysisFeedbackLabel } from "../components/analysis-feedback-button";
import { issueActionLabel } from "../components/feedback-issue-button";

describe("feedback button labels", () => {
  it("shows pending and completed feedback states", () => {
    expect(analysisFeedbackLabel(false, "")).toBe("提交反馈");
    expect(analysisFeedbackLabel(true, "")).toBe("提交中…");
    expect(analysisFeedbackLabel(false, "done")).toBe("已提交反馈");
  });

  it("shows GitHub submission states", () => {
    expect(issueActionLabel(false, "new")).toBe("提交到 GitHub");
    expect(issueActionLabel(true, "new")).toBe("提交中…");
    expect(issueActionLabel(false, "failed")).toBe("重试提交");
  });
});

describe("feedback button rendering", () => {
  it("renders the failure feedback and GitHub actions", () => {
    expect(renderToStaticMarkup(createElement(AnalysisFeedbackButton, { slug: "tingfeng" }))).toContain("提交反馈");
    expect(renderToStaticMarkup(createElement(FeedbackIssueButton, { id: 42, issueUrl: null, status: "new" }))).toContain("提交到 GitHub");
    expect(renderToStaticMarkup(createElement(FeedbackIssueButton, { id: 42, issueUrl: "https://github.com/gzhanlei/codelphi/issues/42", status: "submitted" }))).toContain("查看 Issue");
  });
});

describe("feedback submission handlers", () => {
  beforeEach(() => {
    vi.mocked(submitProductFeedback).mockReset();
    vi.mocked(submitGithubIssue).mockReset();
  });

  it("records a successful product feedback submission", async () => {
    vi.mocked(submitProductFeedback).mockResolvedValue({ id: 42 });
    const controls = { setPending: vi.fn(), setMessage: vi.fn() };
    await handleAnalysisFeedback("tingfeng", controls);
    expect(controls.setPending).toHaveBeenNthCalledWith(1, true);
    expect(controls.setPending).toHaveBeenLastCalledWith(false);
    expect(controls.setMessage).toHaveBeenLastCalledWith("反馈已提交，CoDelphi 团队会查看诊断信息。");
  });

  it("surfaces product feedback errors and resets pending", async () => {
    vi.mocked(submitProductFeedback).mockRejectedValue(new Error("network failed"));
    const controls = { setPending: vi.fn(), setMessage: vi.fn() };
    await handleAnalysisFeedback("tingfeng", controls);
    expect(controls.setMessage).toHaveBeenLastCalledWith("network failed");
    expect(controls.setPending).toHaveBeenLastCalledWith(false);
  });

  it("marks a failed GitHub submission", async () => {
    vi.mocked(submitGithubIssue).mockRejectedValue(new Error("forbidden"));
    const controls = { setPending: vi.fn(), setError: vi.fn(), setIssueUrl: vi.fn(), setStatus: vi.fn() };
    await handleGithubIssue(42, controls);
    expect(controls.setError).toHaveBeenCalledWith("forbidden");
    expect(controls.setStatus).toHaveBeenCalledWith("failed");
  });

  it("stores the created GitHub issue URL", async () => {
    vi.mocked(submitGithubIssue).mockResolvedValue("https://github.com/gzhanlei/codelphi/issues/42");
    const controls = { setPending: vi.fn(), setError: vi.fn(), setIssueUrl: vi.fn(), setStatus: vi.fn() };
    await handleGithubIssue(42, controls);
    expect(controls.setIssueUrl).toHaveBeenCalledWith("https://github.com/gzhanlei/codelphi/issues/42");
    expect(controls.setStatus).toHaveBeenCalledWith("submitted");
  });

  it("validates API error responses", async () => {
    const actual = await vi.importActual<typeof import("../lib/feedback-client")>("../lib/feedback-client");
    vi.mocked(submitProductFeedback).mockImplementation(actual.submitProductFeedback);
    vi.mocked(submitGithubIssue).mockImplementation(actual.submitGithubIssue);
    await expect(submitProductFeedback("tingfeng", vi.fn(async () => Response.json({ error: "failed" }, { status: 500 })))).rejects.toThrow("failed");
    await expect(submitGithubIssue(42, vi.fn(async () => Response.json({}, { status: 200 })))).rejects.toThrow("GitHub Issue 创建失败");
  });
});

describe("analysis failure feedback", () => {
  beforeEach(() => execute.mockReset());

  function input(nextDetails = details) {
    return {
      user: { sub: "reporter", email: "reporter@example.com" },
      organization: { id: 1, slug: "default", name: "Default Workspace", role: "owner" as const },
      details: nextDetails,
    };
  }

  it("rejects feedback when no failed analysis exists", async () => {
    await expect(createFeedbackReport(input({ ...details, latestRun: undefined as never }))).rejects.toThrow("no_failed_analysis");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reuses an existing report for the same failure", async () => {
    execute.mockImplementation(async () => [[{ id: 17 }]]);
    await expect(createFeedbackReport(input())).resolves.toBe(17);
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO feedback_reports"), expect.anything());
  });

  it("uses explicit revision fallbacks without treating an empty SHA as missing", async () => {
    execute.mockImplementation(async (sql = "") => {
      if (sql.includes("SELECT id FROM feedback_reports")) return [[]];
      if (sql.includes("INSERT INTO feedback_reports")) return [{ insertId: 42 }];
      return [{}];
    });
    await createFeedbackReport(input({ ...details, releases: [] }));
    let insert = execute.mock.calls.find((call) => String(call[0]).includes("INSERT INTO feedback_reports"));
    expect(insert?.[1][3]).toBe("unknown");
    execute.mockClear();
    await createFeedbackReport(input({ ...details, releases: [{ ...details.releases[0], sha: "" }] }));
    insert = execute.mock.calls.find((call) => String(call[0]).includes("INSERT INTO feedback_reports"));
    expect(insert?.[1][3]).toBe("");
  });

  it("collects failure context without asking the user for more information", async () => {
    execute.mockImplementation(async (sql = "") => {
      if (sql.includes("SELECT id FROM feedback_reports") || sql.includes("FROM feedback_reports f")) return [[]];
      if (sql.includes("INSERT INTO feedback_reports")) return [{ insertId: 42 }];
      return [{}];
    });
    const id = await createFeedbackReport({
      user: { sub: "reporter", email: "reporter@example.com" },
      organization: { id: 1, slug: "default", name: "Default Workspace", role: "owner" },
      details,
    });
    expect(id).toBe(42);
    const insert = execute.mock.calls.find((call) => String(call[0]).includes("INSERT INTO feedback_reports"));
    expect(insert?.[1]).toEqual(expect.arrayContaining([1, 3, "gzhanlei/workmembership", "abcdef1234567890", "No architecture components detected", "reporter"]));
  });

  it("builds a diagnostic issue body and submits it to the CoDelphi repository", async () => {
    const report = {
      id: 42,
      organizationId: 1,
      organizationName: "Default Workspace",
      productId: 3,
      productName: "Chandler",
      repositoryFullName: "gzhanlei/workmembership",
      revision: "abcdef1234567890",
      errorMessage: "No architecture components detected",
      architectureError: null,
      status: "new",
      githubIssueUrl: null,
      submissionError: null,
      createdAt: new Date("2026-11-03T00:00:00Z"),
    };
    expect(feedbackIssueBody(report)).toContain("No architecture components detected");
    expect(feedbackIssueBody(report)).toContain("gzhanlei/workmembership");
    execute.mockImplementation(async (sql = "") => {
      if (sql.includes("FROM feedback_reports f")) return [[report]];
      return [{ affectedRows: 1 }];
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ html_url: "https://github.com/gzhanlei/codelphi/issues/42" }));
    expect(await submitFeedbackToGitHub(42, { token: "test-token", fetcher })).toBe("https://github.com/gzhanlei/codelphi/issues/42");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/gzhanlei/codelphi/issues");
    expect(JSON.parse(String(init?.body)).labels).toEqual(["feedback", "analysis-failure"]);
  });

  it("explains missing issue write permission", async () => {
    const report = {
      id: 42, organizationId: 1, organizationName: "Default Workspace", productId: 3, productName: "Chandler", repositoryFullName: "gzhanlei/workmembership",
      revision: "abcdef1234567890", errorMessage: "failed", architectureError: null, status: "new", githubIssueUrl: null, submissionError: null, createdAt: new Date(),
    };
    execute.mockImplementation(async (sql = "") => sql.includes("FROM feedback_reports f") ? [[report]] : [{ affectedRows: 1 }]);
    const fetcher = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(submitFeedbackToGitHub(42, { token: "test-token", fetcher })).rejects.toThrow("issues:write");
  });

  it("restricts the admin backend to configured admins or the default workspace owner", () => {
    expect(isPlatformAdmin({ sub: "admin", email: "admin@example.com" }, { id: 1, slug: "default", name: "Default Workspace", role: "owner" }, new Set(["admin@example.com"]))).toBe(true);
    expect(isPlatformAdmin({ sub: "other", email: "other@example.com" }, { id: 1, slug: "default", name: "Default Workspace", role: "owner" }, new Set(["admin@example.com"]))).toBe(false);
    expect(isPlatformAdmin({ sub: "owner" }, { id: 1, slug: "default", name: "Default Workspace", role: "owner" }, new Set())).toBe(true);
    expect(isPlatformAdmin({ sub: "viewer" }, { id: 1, slug: "default", name: "Default Workspace", role: "viewer" }, new Set())).toBe(false);
  });
});
