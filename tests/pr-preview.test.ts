import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderPrPreview, runPrPreview, prPreviewCommentMarker, prPreviewCheckName, type AffectedSpecEntry } from "../lib/pr-preview";

const { execute, getPullRequestFiles, listIssueComments, upsertIssueComment, createCheckRun } = vi.hoisted(() => ({
  execute: vi.fn(),
  getPullRequestFiles: vi.fn(),
  listIssueComments: vi.fn(),
  upsertIssueComment: vi.fn(),
  createCheckRun: vi.fn(),
}));

vi.mock("../lib/db", () => ({ getDb: () => ({ execute }) }));
vi.mock("../lib/code-hosting", () => ({
  getCodeHostingAdapter: () => ({ getPullRequestFiles, listIssueComments, upsertIssueComment, createCheckRun }),
}));
vi.mock("../lib/github-access", () => ({ resolveGitHubToken: vi.fn(async () => "installation-token") }));
vi.mock("../lib/env", () => ({ prPreviewEnabled: vi.fn(() => process.env.PR_PREVIEW_ENABLED !== "false") }));

const job = { repositoryId: 9, number: 7, sha: "pr-sha", owner: "gzhanlei", name: "codelphi" };
const access = { connectionId: 42, organizationId: 7 };

describe("renderPrPreview", () => {
  it("groups affected entries by feature with references and evidence paths", () => {
    const entries: AffectedSpecEntry[] = [
      { featureName: "登录", scenarioReference: "HP-1", path: "lib/auth.ts" },
      { featureName: "登录", scenarioReference: "HP-1", path: "lib/session.ts" },
      { featureName: "登录", scenarioReference: "EC-2", path: "lib/auth.ts" },
      { featureName: "支付", scenarioReference: null, path: "lib/pay.ts" },
    ];
    const body = renderPrPreview(entries, 3, "gzhanlei/codelphi", 7);
    expect(body).toContain(prPreviewCommentMarker("gzhanlei", "codelphi", 7));
    expect(body).toContain("此 PR 触碰 3 个文件，涉及 2 个功能");
    expect(body).toContain("**登录**：场景 HP-1、EC-2（`lib/auth.ts`、`lib/session.ts`）");
    expect(body).toContain("**支付**：`lib/pay.ts`");
    expect(body).toContain("合并后以实际分析为准");
  });
});

describe("runPrPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PR_PREVIEW_ENABLED", "true");
    execute.mockImplementation(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes("FROM repositories repo")) return [[{ provider: "github", defaultBranch: "main", connectionId: 42, organizationId: 7 }]];
      if (sql.includes("FROM spec_file_index")) {
        const queriedPaths = (parameters as string[]).slice(1);
        return [queriedPaths.includes("README.md") ? [] : [
          { featureName: "登录", scenarioReference: "HP-1", path: "lib/auth.ts" },
          { featureName: "登录", scenarioReference: "EC-2", path: "lib/auth.ts" },
        ]];
      }
      return [[]];
    });
    getPullRequestFiles.mockResolvedValue([{ path: "lib/auth.ts", status: "modified", patch: "" }]);
    listIssueComments.mockResolvedValue([{ id: 1, body: "other" }, { id: 2, body: `${prPreviewCommentMarker("gzhanlei", "codelphi", 7)}old` }]);
    upsertIssueComment.mockResolvedValue(2);
    createCheckRun.mockResolvedValue(1);
  });

  it("comments on the PR and posts a success check when touched files intersect the spec index", async () => {
    await runPrPreview(job);
    expect(getPullRequestFiles).toHaveBeenCalledWith(expect.objectContaining({ owner: "gzhanlei", name: "codelphi" }), 7, access);
    expect(upsertIssueComment).toHaveBeenCalledWith(expect.anything(), 7, expect.stringContaining("涉及 1 个功能"), 2, access);
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "gzhanlei", name: "codelphi" }),
      "pr-sha",
      prPreviewCheckName,
      "success",
      "行为预演完成：1 个功能受影响",
      expect.stringContaining("不判断代码正确性"),
      access,
    );
  });

  it("updates the existing marker comment instead of creating a new one", async () => {
    await runPrPreview(job);
    const body = upsertIssueComment.mock.calls[0][2] as string;
    expect(body.startsWith(prPreviewCommentMarker("gzhanlei", "codelphi", 7))).toBe(true);
    expect(upsertIssueComment.mock.calls[0][3]).toBe(2);
  });

  it("runs by default when the switch is unset", async () => {
    vi.stubEnv("PR_PREVIEW_ENABLED", "");
    await runPrPreview(job);
    expect(getPullRequestFiles).toHaveBeenCalled();
  });

  it("still completes the check without commenting when nothing intersects", async () => {
    getPullRequestFiles.mockResolvedValue([{ path: "README.md", status: "modified", patch: "" }]);
    await runPrPreview(job);
    expect(upsertIssueComment).not.toHaveBeenCalled();
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      "pr-sha",
      prPreviewCheckName,
      "success",
      "行为预演：未命中已知规格",
      expect.stringContaining("未命中规格索引"),
      access,
    );
  });

  it("stays fully silent when the gate is switched off", async () => {
    vi.stubEnv("PR_PREVIEW_ENABLED", "false");
    getPullRequestFiles.mockClear();
    await runPrPreview(job);
    expect(getPullRequestFiles).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("swallows failures and marks the check neutral so the merge is not blocked", async () => {
    getPullRequestFiles.mockRejectedValue(new Error("GitHub API 403: Checks write permission missing"));
    await expect(runPrPreview(job)).resolves.toBeUndefined();
    expect(upsertIssueComment).not.toHaveBeenCalled();
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      "pr-sha",
      prPreviewCheckName,
      "neutral",
      "行为预演未完成",
      expect.stringContaining("不阻塞合并"),
      access,
    );
  });
});
