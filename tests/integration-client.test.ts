import { describe, expect, it, vi } from "vitest";
import { connectionAction, deleteRepositoryConnection, repositoryConnectionAction, runConnectionAction, saveRepositoryConnection } from "../lib/integration-client";

describe("integration actions", () => {
  it("returns connection status including an API-reported disconnection", async () => {
    const response = await connectionAction(9, "check", async () => new Response(JSON.stringify({ status: "disconnected", error: "denied" }), { status: 503 }));
    expect(response.status).toBe("disconnected");
  });

  it("throws when the response has no usable error", async () => {
    await expect(connectionAction(9, "disconnect", async () => new Response(JSON.stringify({}), { status: 500 }))).rejects.toThrow("操作失败");
  });

  it("saves repository credentials and surfaces validation errors", async () => {
    const input = { provider: "gitee" as const, token: "secret" };
    const response = await saveRepositoryConnection(input, async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return Response.json({ status: "active", accountLogin: "radar-user" }, { status: 201 });
    });
    expect(response.accountLogin).toBe("radar-user");
    await expect(saveRepositoryConnection(input, async () => Response.json({ error: "令牌无效" }, { status: 400 }))).rejects.toThrow("令牌无效");
    await expect(saveRepositoryConnection(input, async () => Response.json({ status: "active" }, { status: 200 }))).rejects.toThrow("连接保存失败");
    await expect(saveRepositoryConnection(input, async () => Response.json({ error: "" }, { status: 200 }))).rejects.toHaveProperty("message", "");
  });

  it("routes each connection action through its scoped client", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ status: "active" }));
    await runConnectionAction(9, "check", "github", fetcher);
    await runConnectionAction(9, "disconnect", "github", fetcher);
    await runConnectionAction(9, "check", "repository", fetcher);
    await runConnectionAction(9, "delete", "repository", fetcher);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/integrations/github/connections/9/check",
      "/api/integrations/github/connections/9/disconnect",
      "/api/integrations/repositories/9/check",
      "/api/integrations/repositories/9",
    ]);
  });

  it("uses the repository-scoped action endpoints", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "active" }));
    await repositoryConnectionAction(9, "check", fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/integrations/repositories/9/check", { method: "POST" });
    await deleteRepositoryConnection(9, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/integrations/repositories/9", { method: "DELETE" });
  });
});
