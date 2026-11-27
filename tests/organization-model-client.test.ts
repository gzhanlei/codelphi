import { describe, expect, it, vi } from "vitest";
import { deleteOrganizationModel, loadOrganizationModel, saveOrganizationModel } from "../lib/organization-model-client";

const model = { baseUrl: "https://api.kimi.com/coding/v1", model: "k3-256k", verifiedAt: "2026-11-27T10:00:00.000Z" };
const respond = (status: number, body: unknown) => vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

describe("the settings page's calls for the workspace's model configuration", () => {
  it("loads what is saved, and nothing when nothing is", async () => {
    const fetcher = respond(200, { model });
    expect(await loadOrganizationModel(fetcher)).toEqual(model);
    expect(fetcher).toHaveBeenCalledWith("/api/organization-model", { cache: "no-store" });
    expect(await loadOrganizationModel(respond(200, { model: null }))).toBeNull();
  });

  it("sends exactly what was typed and brings back what was saved", async () => {
    const input = { baseUrl: "https://api.kimi.com/coding/v1", apiKey: "sk-kimi-secret", model: "k3-256k" };
    const fetcher = respond(200, { status: "saved", model });
    expect(await saveOrganizationModel(input, fetcher)).toEqual(model);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/organization-model");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("says why the server refused, so the page can show it", async () => {
    const fetcher = respond(400, { error: "模型没有通过验证：the workspace's model provider answered 404: model not found" });
    await expect(saveOrganizationModel({ baseUrl: "https://a.example/v1", apiKey: "k", model: "m" }, fetcher)).rejects.toThrow(/^模型没有通过验证：.*model not found/);
    await expect(loadOrganizationModel(respond(403, { error: "只有工作区成员可以管理模型配置" }))).rejects.toThrow("只有工作区成员可以管理模型配置");
    // 删除被拒时，页面要的是那句解释（哪些产品还在用），不是错误码。
    await expect(deleteOrganizationModel(respond(409, { error: "model_in_use", products: ["airecord"], message: "还有产品由服务端分析：airecord。" }))).rejects.toThrow(/^还有产品由服务端分析：airecord/);
    await expect(deleteOrganizationModel(respond(200, { status: "unexpected" }))).rejects.toThrow("删除模型配置失败");
  });

  it("does not take an incomplete success for a saved configuration", async () => {
    await expect(saveOrganizationModel({ baseUrl: "https://a.example/v1", apiKey: "k", model: "m" }, respond(200, { status: "pending", model }))).rejects.toThrow("保存模型配置失败");
    await expect(saveOrganizationModel({ baseUrl: "https://a.example/v1", apiKey: "k", model: "m" }, respond(200, { status: "saved" }))).rejects.toThrow("保存模型配置失败");
  });

  it("falls back to the error code when the explanation is empty", async () => {
    await expect(deleteOrganizationModel(respond(409, { error: "model_in_use", message: "" }))).rejects.toThrow("model_in_use");
  });

  it("deletes", async () => {
    const fetcher = respond(200, { status: "deleted" });
    expect(await deleteOrganizationModel(fetcher)).toBe("deleted");
    expect(fetcher).toHaveBeenCalledWith("/api/organization-model", { method: "DELETE" });
  });
});
