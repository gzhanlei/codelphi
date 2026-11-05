import { describe, expect, it, vi } from "vitest";
import { processGitHubWebhook, resolveGitHubWebhookSecrets } from "../lib/github-webhook";

const payload = JSON.stringify({ ref: "refs/heads/main", before: "before", after: "after", repository: { full_name: "gzhanlei/radar" } });

function dependencies() {
  return {
    verify: vi.fn((_rawBody: string, _signature: string | null, _secret: string) => true),
    findRepository: vi.fn(async (): Promise<{ id: number; defaultBranch: string } | undefined> => ({ id: 9, defaultBranch: "main" })),
    queue: vi.fn(async () => 42),
  };
}

describe("GitHub webhook processing", () => {
  it("uses app and legacy webhook secrets without breaking existing repositories", async () => {
    expect(await resolveGitHubWebhookSecrets(async () => ({ webhookSecret: "app-secret" }), { GITHUB_WEBHOOK_SECRET: "legacy-secret" })).toEqual(["app-secret", "legacy-secret"]);
    expect(await resolveGitHubWebhookSecrets(async () => ({ webhookSecret: "app-secret" }), {})).toEqual(["app-secret"]);
    expect(await resolveGitHubWebhookSecrets(async () => null, { GITHUB_WEBHOOK_SECRET: "legacy-secret" })).toEqual(["legacy-secret"]);
    expect(await resolveGitHubWebhookSecrets(async () => ({ webhookSecret: "" }), { GITHUB_WEBHOOK_SECRET: "legacy-secret" })).toEqual(["legacy-secret"]);
    expect(await resolveGitHubWebhookSecrets(async () => ({ webhookSecret: "same" }), { GITHUB_WEBHOOK_SECRET: "same" })).toEqual(["same"]);
    await expect(resolveGitHubWebhookSecrets(async () => null, {})).rejects.toThrow("GITHUB_WEBHOOK_SECRET is not configured");
  });

  it("accepts either an app-level or legacy repository webhook signature", async () => {
    const deps = dependencies();
    deps.verify.mockImplementation((_rawBody, _signature, secret) => secret === "app-secret");
    const result = await processGitHubWebhook({ rawBody: payload, event: "push", signature: "sig", secret: ["legacy-secret", "app-secret"] }, deps);
    expect(result.body).toEqual({ accepted: true, runId: 42 });
    expect(deps.verify).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid signatures and ignores unrelated events", async () => {
    const deps = dependencies();
    deps.verify.mockReturnValue(false);
    expect((await processGitHubWebhook({ rawBody: payload, event: "push", signature: null, secret: "secret" }, deps)).status).toBe(401);
    expect((await processGitHubWebhook({ rawBody: payload, event: "ping", signature: "sig", secret: "secret" }, dependencies())).body).toEqual({ ok: true });
    expect((await processGitHubWebhook({ rawBody: payload, event: "release", signature: "sig", secret: "secret" }, dependencies())).body).toEqual({ ignored: true });
  });

  it("ignores deleted branches, unknown repositories and non-default branches", async () => {
    expect((await processGitHubWebhook({ rawBody: JSON.stringify({ ref: "refs/heads/main", before: "b", after: "0000000000000000000000000000000000000000", repository: { full_name: "gzhanlei/radar" } }), event: "push", signature: "sig", secret: "secret" }, dependencies())).body).toEqual({ ignored: "branch_deleted" });
    const deps = dependencies();
    deps.findRepository.mockResolvedValue(undefined);
    expect((await processGitHubWebhook({ rawBody: payload, event: "push", signature: "sig", secret: "secret" }, deps)).status).toBe(202);
    const branchDeps = dependencies();
    branchDeps.findRepository.mockResolvedValue({ id: 9, defaultBranch: "develop" });
    expect((await processGitHubWebhook({ rawBody: payload, event: "push", signature: "sig", secret: "secret" }, branchDeps)).body).toEqual({ ignored: "unregistered_repository_or_branch" });
  });

  it("queues a registered default-branch push", async () => {
    const deps = dependencies();
    const result = await processGitHubWebhook({ rawBody: payload, event: "push", signature: "sig", secret: "secret" }, deps);
    expect(result).toEqual({ status: 202, body: { accepted: true, runId: 42 }, runId: 42 });
    expect(deps.queue).toHaveBeenCalledWith(9, "before", "after");
  });
});
