import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGitHubTokenCache, resolveGitHubToken } from "../lib/github-access";

const appConnection = { id: 1, connectionId: 9, installationId: 42, status: "active", clientId: "Iv1.test", pem: "pem" };

describe("GitHub access resolution", () => {
  beforeEach(() => {
    clearGitHubTokenCache();
    vi.stubEnv("GITHUB_TOKEN", "pat-token");
  });

  it("keeps explicit and environment PAT fallbacks", async () => {
    expect(await resolveGitHubToken({ token: "explicit" })).toBe("explicit");
    expect(await resolveGitHubToken()).toBe("pat-token");
  });

  it("uses and caches an installation token", async () => {
    const dependencies = {
      loadConnection: vi.fn(async () => appConnection),
      issueToken: vi.fn(async () => ({ token: "installation-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() })),
    };
    expect(await resolveGitHubToken({ connectionId: 9 }, dependencies)).toBe("installation-token");
    expect(await resolveGitHubToken({ connectionId: 9 }, dependencies)).toBe("installation-token");
    expect(dependencies.issueToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes a token at the five-minute expiry boundary", async () => {
    const dependencies = {
      loadConnection: vi.fn(async () => appConnection),
      issueToken: vi.fn(async () => ({ token: "boundary-token", expiresAt: new Date(Date.now() + 300_000).toISOString() })),
    };
    await resolveGitHubToken({ connectionId: 9 }, dependencies);
    await resolveGitHubToken({ connectionId: 9 }, dependencies);
    expect(dependencies.issueToken).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expiring token and rejects disconnected installations", async () => {
    const dependencies = {
      loadConnection: vi.fn(async () => appConnection),
      issueToken: vi.fn(async () => ({ token: "fresh-token", expiresAt: new Date(Date.now() + 1000).toISOString() })),
    };
    await resolveGitHubToken({ connectionId: 9 }, dependencies);
    await resolveGitHubToken({ connectionId: 9 }, dependencies);
    expect(dependencies.issueToken).toHaveBeenCalledTimes(2);
    await expect(resolveGitHubToken({ connectionId: 9 }, { ...dependencies, loadConnection: async () => ({ ...appConnection, status: "disconnected" }) })).rejects.toThrow("disconnected");
  });
});
