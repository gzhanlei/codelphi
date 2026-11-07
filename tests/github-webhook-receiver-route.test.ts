import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/webhooks/github/route";
import { processGitHubWebhook, resolveGitHubWebhookSecrets } from "../lib/github-webhook";

const { afterMock, runAnalysisMock, runPrPreviewMock } = vi.hoisted(() => ({ afterMock: vi.fn(), runAnalysisMock: vi.fn(), runPrPreviewMock: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...await importOriginal<typeof import("next/server")>(), after: afterMock }));
vi.mock("../lib/analysis", () => ({ runAnalysis: runAnalysisMock }));
vi.mock("../lib/pr-preview", () => ({ runPrPreview: runPrPreviewMock }));
vi.mock("../lib/github-webhook", () => ({
  processGitHubWebhook: vi.fn(async () => ({ status: 202, body: { accepted: true, runId: 42 }, runId: 42 })),
  resolveGitHubWebhookSecrets: vi.fn(async () => ["app-secret", "legacy-secret"]),
}));

function requestFor(event: string) {
  return new NextRequest("https://codelphi.com/api/webhooks/github", {
    method: "POST",
    headers: { "x-github-event": event, "x-hub-signature-256": "sig" },
    body: JSON.stringify({ ref: "refs/heads/main" }),
  });
}

describe("GitHub webhook receiver route", () => {
  beforeEach(() => {
    afterMock.mockClear();
    runAnalysisMock.mockClear();
    runPrPreviewMock.mockClear();
  });

  it("passes both app and legacy secrets and schedules the accepted run", async () => {
    const response = await POST(requestFor("push"));
    expect(response.status).toBe(202);
    expect(resolveGitHubWebhookSecrets).toHaveBeenCalledOnce();
    expect(processGitHubWebhook).toHaveBeenCalledWith(expect.objectContaining({ event: "push", signature: "sig", secret: ["app-secret", "legacy-secret"] }));
    expect(afterMock).toHaveBeenCalledOnce();
    const task = afterMock.mock.calls[0][0] as () => Promise<void>;
    await task();
    expect(runAnalysisMock).toHaveBeenCalledWith(42);
    expect(runPrPreviewMock).not.toHaveBeenCalled();
  });

  it("schedules the PR preview job for pull_request events", async () => {
    vi.mocked(processGitHubWebhook).mockResolvedValueOnce({
      status: 202,
      body: { accepted: true },
      preview: { repositoryId: 9, number: 7, sha: "pr-sha", owner: "gzhanlei", name: "radar" },
    });
    const response = await POST(requestFor("pull_request"));
    expect(response.status).toBe(202);
    expect(afterMock).toHaveBeenCalledOnce();
    const task = afterMock.mock.calls[0][0] as () => Promise<void>;
    await task();
    expect(runPrPreviewMock).toHaveBeenCalledWith({ repositoryId: 9, number: 7, sha: "pr-sha", owner: "gzhanlei", name: "radar" });
    expect(runAnalysisMock).not.toHaveBeenCalled();
  });
});
