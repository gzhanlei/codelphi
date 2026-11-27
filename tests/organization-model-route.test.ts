import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteOrganizationModel, describeOrganizationModel, saveOrganizationModel, requestDetailed } = vi.hoisted(() => ({
  deleteOrganizationModel: vi.fn(),
  describeOrganizationModel: vi.fn(),
  saveOrganizationModel: vi.fn(),
  requestDetailed: vi.fn(),
}));

// 存储换成替身；绑定和两个错误类是真的（路由靠 instanceof 认它们）。出口换成替身，测试不碰网络。
vi.mock("../lib/organization-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/organization-model")>()),
  deleteOrganizationModel,
  describeOrganizationModel,
  saveOrganizationModel,
}));
vi.mock("../lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai")>()),
  requestStructuredCompletionDetailed: requestDetailed,
}));
vi.mock("../lib/session", () => ({ requireSessionUser: vi.fn() }));
vi.mock("../lib/organizations", () => ({ requireOrganization: vi.fn() }));

import { DELETE, GET, PUT } from "../app/api/organization-model/route";
import { requireOrganization } from "../lib/organizations";
import { requireSessionUser } from "../lib/session";
import { currentOrganizationModel } from "../lib/organization-model";

const organization = { id: 7, slug: "team", name: "Team", role: "editor" as const };
const KEY = "sk-kimi-secret";
const stored = { baseUrl: "https://api.kimi.com/coding/v1", model: "k3-256k", verifiedAt: new Date("2026-11-27T10:00:00.000Z"), updatedAt: new Date("2026-11-27T10:00:00.000Z") };
const put = (body: unknown) => PUT(new NextRequest("https://codelphi.example/api/organization-model", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

describe("the workspace's model configuration route", () => {
  /** 出口每次被调用时，范围内绑定的模型。 */
  const seen: unknown[] = [];

  beforeEach(() => {
    seen.length = 0;
    vi.clearAllMocks();
    vi.mocked(requireSessionUser).mockResolvedValue({ id: 3, sub: "user-1", email: "a@b.c", name: "A", picture: "" } as never);
    vi.mocked(requireOrganization).mockResolvedValue(organization as never);
    requestDetailed.mockImplementation(async () => {
      // 出口被调用的那一刻，分析的范围内绑定的应当是用户刚填的那一份。
      seen.push(currentOrganizationModel());
      return { content: '{"ok":true}', usageRaw: null, providerRequestId: "k-1", finishReason: "stop" };
    });
    describeOrganizationModel.mockResolvedValue(stored);
    deleteOrganizationModel.mockResolvedValue(true);
    saveOrganizationModel.mockResolvedValue(undefined);
  });

  it("answers 403 to anyone who is not an editor of the workspace, on every method", async () => {
    vi.mocked(requireOrganization).mockRejectedValue(new Error("forbidden"));
    expect((await GET()).status).toBe(403);
    expect((await put({ baseUrl: stored.baseUrl, apiKey: KEY, model: stored.model })).status).toBe(403);
    expect((await DELETE()).status).toBe(403);
    expect(requestDetailed).not.toHaveBeenCalled();
    expect(saveOrganizationModel).not.toHaveBeenCalled();
    expect(deleteOrganizationModel).not.toHaveBeenCalled();
  });

  it("describes the saved configuration without the key", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.model).toMatchObject({ baseUrl: stored.baseUrl, model: stored.model, verifiedAt: stored.verifiedAt.toISOString() });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("refuses an incomplete form without calling anyone", async () => {
    for (const body of [{}, { baseUrl: stored.baseUrl, apiKey: KEY, model: "  " }, { baseUrl: "https://api.example/v1", apiKey: "", model: "m" }, { baseUrl: "https://api.example/v1", apiKey: KEY, model: "x".repeat(65) }]) {
      const response = await put(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/请填写|最多/);
    }
    expect(requestDetailed).not.toHaveBeenCalled();
    expect(saveOrganizationModel).not.toHaveBeenCalled();
    // 说的是第一个问题的原因，不是笼统的那一句。
    const tooLong = await put({ baseUrl: "https://api.example/v1", apiKey: KEY, model: "x".repeat(65) });
    expect((await tooLong.json()).error).toBe("模型名最多 64 个字符");
  });

  it("refuses an address the server must not connect to, and says why in words", async () => {
    for (const [baseUrl, expected] of [
      ["http://api.example/v1", /https/],
      ["https://user:pass@api.example/v1", /用户名|密码/],
      ["https://127.0.0.1:4000/v1", /公网|内网|本机/],
      ["https://api.example/v1?x=1", /查询/],
    ] as const) {
      const response = await put({ baseUrl, apiKey: KEY, model: stored.model });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(expected);
    }
    expect(requestDetailed).not.toHaveBeenCalled();
    expect(saveOrganizationModel).not.toHaveBeenCalled();
  });

  it("calls the model once with exactly what was typed, bound to the workspace, and saves only after it answers", async () => {
    const response = await put({ baseUrl: "  https://api.kimi.com/coding/v1  ", apiKey: KEY, model: "k3-256k" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "saved", model: { baseUrl: stored.baseUrl, model: stored.model, verifiedAt: stored.verifiedAt.toISOString(), updatedAt: stored.updatedAt.toISOString() } });
    expect(JSON.stringify(body)).not.toContain(KEY);

    expect(requestDetailed).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ organizationId: 7, baseUrl: "https://api.kimi.com/coding/v1", apiKey: KEY, model: "k3-256k" }]);
    // 保存用的是验证过的那一份：地址已经过校验，key 是用户填的原文，记下是谁保存的。
    expect(saveOrganizationModel).toHaveBeenCalledTimes(1);
    expect(saveOrganizationModel.mock.calls[0][1]).toEqual({ organizationId: 7, baseUrl: "https://api.kimi.com/coding/v1", apiKey: KEY, model: "k3-256k", by: "user-1" });
    expect(deleteOrganizationModel).not.toHaveBeenCalled();
  });

  it("does not save when the model refuses, and tells the user what the provider said", async () => {
    requestDetailed.mockRejectedValue(new Error("the workspace's model provider answered 404: model k3-256k not found"));
    const response = await put({ baseUrl: stored.baseUrl, apiKey: KEY, model: stored.model });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("模型没有通过验证：the workspace's model provider answered 404: model k3-256k not found");
    expect(saveOrganizationModel).not.toHaveBeenCalled();
  });

  it("does not save when the address cannot be reached or resolved, and when the answer is empty", async () => {
    const { ModelUrlError } = await import("../lib/organization-model");
    requestDetailed.mockRejectedValueOnce(new ModelUrlError("unresolvable", "could not resolve api.example: ENOTFOUND"));
    let response = await put({ baseUrl: "https://api.example/v1", apiKey: KEY, model: "m" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/解析/);

    requestDetailed.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    response = await put({ baseUrl: "https://api.example/v1", apiKey: KEY, model: "m" });
    expect((await response.json()).error).toMatch(/没有(应答|回答)/);

    // 只有空白、或者回答被截断（finishReason = length）：都不能算验证通过。
    requestDetailed.mockResolvedValueOnce({ content: "   ", usageRaw: null, providerRequestId: null, finishReason: "stop" });
    response = await put({ baseUrl: "https://api.example/v1", apiKey: KEY, model: "m" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/没有返回/);
    requestDetailed.mockResolvedValueOnce({ content: '{"ok":tr', usageRaw: null, providerRequestId: null, finishReason: "length" });
    response = await put({ baseUrl: "https://api.example/v1", apiKey: KEY, model: "m" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/截断/);
    expect(saveOrganizationModel).not.toHaveBeenCalled();
  });

  it("deletes the configuration", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });
    expect(deleteOrganizationModel).toHaveBeenCalledWith(7);
  });

  it("refuses to delete while a product still runs on the server, naming it", async () => {
    const { ModelInUseError } = await import("../lib/organization-model");
    deleteOrganizationModel.mockRejectedValue(new ModelInUseError(["airecord", "shop"]));
    const response = await DELETE();
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ error: "model_in_use", products: ["airecord", "shop"], message: "还有产品由服务端分析：airecord、shop。删掉模型配置后它们无法分析。先把它们改成客户端分析，再删除。" });
  });
});
