import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/webhooks/github/route";
import { processGitHubWebhook, resolveGitHubWebhookSecrets } from "../lib/github-webhook";

const { afterMock, runAnalysisMock } = vi.hoisted(() => ({ afterMock: vi.fn(), runAnalysisMock: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...await importOriginal<typeof import("next/server")>(), after: afterMock }));
vi.mock("../lib/analysis", () => ({ runAnalysis: runAnalysisMock }));
vi.mock("../lib/github-webhook", () => ({
  processGitHubWebhook: vi.fn(async () => ({ status: 202, body: { accepted: true, runId: 42 }, runId: 42 })),
  resolveGitHubWebhookSecrets: vi.fn(async () => ["app-secret", "legacy-secret"]),
}));

describe("GitHub webhook receiver route", () => {
  it("passes both app and legacy secrets and schedules the accepted run", async () => {
    const request = new NextRequest("https://radar.chandler.work/api/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "push", "x-hub-signature-256": "sig" },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(resolveGitHubWebhookSecrets).toHaveBeenCalledOnce();
    expect(processGitHubWebhook).toHaveBeenCalledWith(expect.objectContaining({ event: "push", signature: "sig", secret: ["app-secret", "legacy-secret"] }));
    expect(afterMock).toHaveBeenCalledOnce();
    const task = afterMock.mock.calls[0][0] as () => Promise<void>;
    await task();
    expect(runAnalysisMock).toHaveBeenCalledWith(42);
  });
});
