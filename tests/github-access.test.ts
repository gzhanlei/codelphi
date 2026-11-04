import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGitHubTokenCache, resolveGitHubToken } from "../lib/github-access";

const appConnection = { id: 1, connectionId: 9, installationId: 42, status: "active", clientId: "Iv1.test", pem: "pem" };

function dependencies() {
  return {
    loadConnection: vi.fn(async (_id: number, _organizationId: number) => appConnection),
    issueToken: vi.fn(async () => ({ token: "installation-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() })),
  };
}

describe("GitHub access resolution", () => {
  beforeEach(() => {
    clearGitHubTokenCache();
    vi.stubEnv("GITHUB_TOKEN", "pat-token");
  });

  it("keeps explicit and environment PAT fallbacks", async () => {
    expect(await resolveGitHubToken({ token: "explicit" })).toBe("explicit");
    expect(await resolveGitHubToken()).toBe("pat-token");
  });

  it("requires a workspace for installation access", async () => {
    const gateway = dependencies();
    await expect(resolveGitHubToken({ connectionId: 9 }, gateway)).rejects.toThrow("organization is required");
    expect(gateway.loadConnection).not.toHaveBeenCalled();
  });

  it("uses and caches an installation token per workspace", async () => {
    const gateway = dependencies();
    expect(await resolveGitHubToken({ connectionId: 9, organizationId: 1 }, gateway)).toBe("installation-token");
    expect(await resolveGitHubToken({ connectionId: 9, organizationId: 1 }, gateway)).toBe("installation-token");
    expect(await resolveGitHubToken({ connectionId: 9, organizationId: 2 }, gateway)).toBe("installation-token");
    expect(gateway.issueToken).toHaveBeenCalledTimes(2);
    expect(gateway.loadConnection).toHaveBeenNthCalledWith(1, 9, 1);
    expect(gateway.loadConnection).toHaveBeenNthCalledWith(2, 9, 1);
    expect(gateway.loadConnection).toHaveBeenNthCalledWith(3, 9, 2);
  });

  it("rejects a disconnected installation even when its token is cached", async () => {
    const gateway = dependencies();
    await resolveGitHubToken({ connectionId: 9, organizationId: 1 }, gateway);
    gateway.loadConnection.mockResolvedValue({ ...appConnection, status: "disconnected" });
    await expect(resolveGitHubToken({ connectionId: 9, organizationId: 1 }, gateway)).rejects.toThrow("disconnected");
    expect(gateway.issueToken).toHaveBeenCalledOnce();
  });

  it("refreshes a token at the five-minute expiry boundary", async () => {
    const gateway = dependencies();
    gateway.issueToken.mockResolvedValue({ token: "boundary-token", expiresAt: new Date(Date.now() + 300_000).toISOString() });
    await resolveGitHubToken({ connectionId: 9, organizationId: 1 }, gateway);
    await resolveGitHubToken({ connectionId: 9, organizationId: 1 }, gateway);
    expect(gateway.issueToken).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expiring token and rejects disconnected installations", async () => {
    const gateway = dependencies();
    gateway.issueToken.mockResolvedValue({ token: "fresh-token", expiresAt: new Date(Date.now() + 1000).toISOString() });
    await resolveGitHubToken({ connectionId: 9, organizationId: 1 }, gateway);
    await resolveGitHubToken({ connectionId: 9, organizationId: 1 }, gateway);
    expect(gateway.issueToken).toHaveBeenCalledTimes(2);
    await expect(resolveGitHubToken(
      { connectionId: 9, organizationId: 1 },
      { ...gateway, loadConnection: async () => ({ ...appConnection, status: "disconnected" }) },
    )).rejects.toThrow("disconnected");
  });
});
