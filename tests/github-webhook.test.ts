import { describe, expect, it, vi } from "vitest";
import { processGitHubWebhook, resolveGitHubWebhookSecrets } from "../lib/github-webhook";

const payload = JSON.stringify({ ref: "refs/heads/main", before: "before", after: "after", repository: { full_name: "gzhanlei/codelphi" } });

function dependencies() {
  return {
    verify: vi.fn((_rawBody: string, _signature: string | null, _secret: string) => true),
    findRepository: vi.fn(async (): Promise<{ id: number; defaultBranch: string } | undefined> => ({ id: 9, defaultBranch: "main" })),
    queue: vi.fn(async () => 42),
    enqueue: vi.fn(async () => ({ runId: 42, reused: false })),
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
    expect((await processGitHubWebhook({ rawBody: JSON.stringify({ ref: "refs/heads/main", before: "b", after: "0000000000000000000000000000000000000000", repository: { full_name: "gzhanlei/codelphi" } }), event: "push", signature: "sig", secret: "secret" }, dependencies())).body).toEqual({ ignored: "branch_deleted" });
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

  it("rejects a push payload whose repository full_name is not owner/name at the entry schema", async () => {
    const deps = dependencies();
    const malformed = JSON.stringify({ ref: "refs/heads/main", before: "b", after: "a", repository: { full_name: "just-a-name" } });
    await expect(processGitHubWebhook({ rawBody: malformed, event: "push", signature: "sig", secret: "secret" }, deps)).rejects.toThrow("full_name must be owner/name");
    expect(deps.findRepository).not.toHaveBeenCalled();
  });

  it("dispatches opened and synchronized pull requests to preview", async () => {
    const deps = dependencies();
    const prPayload = (action: string, number = 7) => JSON.stringify({ action, pull_request: { number, head: { sha: "pr-sha" }, base: { ref: "main" } }, repository: { full_name: "gzhanlei/codelphi" } });
    for (const action of ["opened", "synchronize"]) {
      const result = await processGitHubWebhook({ rawBody: prPayload(action), event: "pull_request", signature: "sig", secret: "secret" }, deps);
      expect(result.status).toBe(202);
      expect(result.preview).toEqual({ repositoryId: 9, number: 7, sha: "pr-sha", owner: "gzhanlei", name: "codelphi" });
      expect(deps.queue).not.toHaveBeenCalled();
    }
  });

  it("ignores pull request actions and unregistered repositories without queuing analysis", async () => {
    const deps = dependencies();
    const closed = JSON.stringify({ action: "closed", pull_request: { number: 7, head: { sha: "pr-sha" }, base: { ref: "main" } }, repository: { full_name: "gzhanlei/codelphi" } });
    expect((await processGitHubWebhook({ rawBody: closed, event: "pull_request", signature: "sig", secret: "secret" }, deps)).body).toEqual({ ignored: true });
    const unknown = dependencies();
    unknown.findRepository.mockResolvedValue(undefined);
    const opened = JSON.stringify({ action: "opened", pull_request: { number: 7, head: { sha: "pr-sha" }, base: { ref: "main" } }, repository: { full_name: "gzhanlei/codelphi" } });
    const result = await processGitHubWebhook({ rawBody: opened, event: "pull_request", signature: "sig", secret: "secret" }, unknown);
    expect(result.body).toEqual({ ignored: true });
    expect(result.preview).toBeUndefined();
    expect(deps.queue).not.toHaveBeenCalled();
  });
});
