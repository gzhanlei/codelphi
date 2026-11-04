import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitHubConnection } from "../lib/github-connections";
import { getAppInstallation } from "../lib/github-app";
import { getConnectionWithApp, saveInstallation, setConnectionStatus } from "../lib/github-integrations";

vi.mock("../lib/github-app", () => ({ getAppInstallation: vi.fn() }));
vi.mock("../lib/github-integrations", () => ({ getConnectionWithApp: vi.fn(), saveInstallation: vi.fn(), setConnectionStatus: vi.fn() }));

const connection = { id: 1, appId: 1, slug: "radar", clientId: "client", clientSecret: "secret", pem: "pem", webhookSecret: undefined, connectionId: 9, installationId: 42, accountLogin: "gzhanlei", accountType: "User", status: "active", organizationId: 7 };

describe("GitHub connection checks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 for an unknown connection", async () => {
    vi.mocked(getConnectionWithApp).mockResolvedValue(null);
    expect((await checkGitHubConnection(9, 7)).status).toBe(404);
    expect(getConnectionWithApp).toHaveBeenCalledWith(9, 7);
  });

  it("verifies and refreshes an active installation", async () => {
    vi.mocked(getConnectionWithApp).mockResolvedValue(connection);
    vi.mocked(getAppInstallation).mockResolvedValue({ id: 42, account: { login: "gzhanlei", type: "User" } });
    const result = await checkGitHubConnection(9, 7);
    expect(result.status).toBe(200);
    expect(saveInstallation).toHaveBeenCalledWith(1, { id: 42, account: { login: "gzhanlei", type: "User" } }, 7);
  });

  it("marks the actual connection disconnected on API failure", async () => {
    vi.mocked(getConnectionWithApp).mockResolvedValue(connection);
    vi.mocked(getAppInstallation).mockRejectedValue(new Error("denied"));
    const result = await checkGitHubConnection(9, 7);
    expect(result.status).toBe(503);
    expect(setConnectionStatus).toHaveBeenCalledWith(9, "disconnected", 7);
  });
});
