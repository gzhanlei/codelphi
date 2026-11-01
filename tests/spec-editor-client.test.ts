import { describe, expect, it, vi } from "vitest";
import { deleteConfirmedFeature, deleteConfirmedScenario, deleteScenarioRequest, saveScenario } from "../lib/spec-editor-client";

const input = { context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy" as const };

describe("spec editor client", () => {
  it("creates and updates scenarios through the correct routes", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 1, reference: "HP-1", ...input }, { status: 201 }));
    await saveScenario(7, input, undefined, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/features/7/scenarios", expect.objectContaining({ method: "POST" }));
    await saveScenario(7, input, 3, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/scenarios/3", expect.objectContaining({ method: "PUT" }));
  });

  it("surfaces server errors and confirms deletions", async () => {
    await expect(saveScenario(7, input, undefined, async () => Response.json({ error: "无效输入" }, { status: 400 }))).rejects.toThrow("无效输入");
    await expect(saveScenario(7, input, undefined, async () => {
      const response = Response.json({ id: 1 });
      response.headers.delete("content-type");
      return response;
    })).resolves.toEqual({ id: 1 });
    await expect(saveScenario(7, input, undefined, async () => Response.json({}, { status: 500 }))).rejects.toThrow("保存失败，请重试");
    await expect(saveScenario(7, input, undefined, async () => Response.json({ error: "" }, { status: 500 }))).rejects.toThrow("保存失败，请重试");
    await expect(saveScenario(7, input, undefined, async () => new Response("<html>login</html>", { status: 200, headers: { "Content-Type": "text/html" } }))).rejects.toThrow("服务返回了无效响应");
    await expect(saveScenario(7, input, undefined, async () => new Response("<html>login</html>", { status: 401, headers: { "Content-Type": "text/html" } }))).rejects.toThrow("登录已过期，请重新登录");
    const fetcher = vi.fn(async () => Response.json({ status: "deleted" }));
    await deleteScenarioRequest(3, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/scenarios/3", { method: "DELETE" });
  });

  it("only deletes confirmed features and scenarios", async () => {
    const fetcher = vi.fn(async () => Response.json({ status: "deleted" }));
    expect(await deleteConfirmedFeature(undefined, () => true, fetcher)).toBe(false);
    expect(await deleteConfirmedFeature({ id: 4, name: "Tree" }, () => false, fetcher)).toBe(false);
    expect(await deleteConfirmedFeature({ id: 4, name: "Tree" }, () => true, fetcher)).toBe(true);
    expect(await deleteConfirmedScenario({ id: 8, reference: "HP-1" }, () => false, fetcher)).toBe(false);
    expect(await deleteConfirmedScenario({ id: 8, reference: "HP-1" }, () => true, fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/features/4", { method: "DELETE" });
    expect(fetcher).toHaveBeenCalledWith("/api/scenarios/8", { method: "DELETE" });
  });
});
