import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenIntegrationCard } from "../components/token-integration-card";
import { saveRepositoryConnection } from "../lib/integration-client";
import type { RepositoryConnectionState } from "../lib/repository-connections";

const { saveMock, refreshMock, useStateMock, stateSetters, stateValues } = vi.hoisted(() => ({
  saveMock: vi.fn(), refreshMock: vi.fn(), useStateMock: vi.fn(), stateSetters: [] as Array<ReturnType<typeof vi.fn>>, stateValues: {} as Record<number, unknown>,
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: useStateMock,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock("../lib/integration-client", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/integration-client")>(), saveRepositoryConnection: saveMock }));

const connection: RepositoryConnectionState = {
  id: 9, provider: "gitee", displayName: "CoDelphi User", accountLogin: "radar-user", baseUrl: "https://gitee.com", tokenHint: "····cret", status: "active", lastError: null, lastCheckedAt: null,
};

function props(kind: "gitee" | "self-hosted" = "gitee") {
  return { kind, connections: [] as RepositoryConnectionState[], canEdit: true };
}

async function submit(kind: "gitee" | "self-hosted") {
  const section = TokenIntegrationCard(props(kind)) as React.ReactElement<{ children: React.ReactElement[] }>;
  const form = section.props.children[3] as React.ReactElement<{ onSubmit: (event: { preventDefault: () => void }) => Promise<void> }>;
  await form.props.onSubmit({ preventDefault: vi.fn() });
}

describe("token integration card behavior", () => {
  beforeEach(() => {
    saveMock.mockReset();
    refreshMock.mockReset();
    useStateMock.mockReset();
    stateSetters.length = 0;
    for (const key of Object.keys(stateValues)) delete stateValues[Number(key)];
    useStateMock.mockImplementation((initial) => {
      const index = stateSetters.length;
      const setter = vi.fn();
      stateSetters.push(setter);
      return [Object.prototype.hasOwnProperty.call(stateValues, index) ? stateValues[index] : initial, setter];
    });
  });

  it("renders required self-hosted fields and safe default states", () => {
    const html = renderToStaticMarkup(createElement(TokenIntegrationCard, { ...props("self-hosted"), connections: [connection] }));
    expect(html).toContain("自有 Git 服务");
    expect(html).toContain("尚未配置主机白名单");
    expect(html).toContain("required=\"\"");
    expect(html).toContain("placeholder=\"粘贴 GitLab 访问令牌\"");
    expect(html).toContain("spellCheck=\"false\"");
    expect(html).toContain("验证并保存连接");
    expect(html).not.toContain("正在验证连接");
    expect(html).not.toContain("form-success");
    expect(html).not.toContain("connection-error");
  });

  it("renders saved connection errors and non-default pending and success states", () => {
    const gitee = renderToStaticMarkup(createElement(TokenIntegrationCard, { ...props(), connections: [{ ...connection, lastError: "Token expired" }] }));
    expect(gitee).toContain("Token expired");
    expect(gitee).toContain("placeholder=\"粘贴 Gitee 私人令牌\"");
    stateSetters.length = 0;
    stateValues[3] = true;
    stateValues[5] = "已连接 Gitee 账号 @radar-user。";
    const html = renderToStaticMarkup(createElement(TokenIntegrationCard, props()));
    expect(html).toContain("正在验证连接");
    expect(html).toContain("form-success");
    expect(html).toContain("已连接 Gitee 账号 @radar-user");
  });

  it("saves a Gitee token without a base URL and refreshes after success", async () => {
    stateValues[2] = "gitee-token";
    saveMock.mockResolvedValue({ accountLogin: "radar-user" });
    await submit("gitee");
    expect(saveMock).toHaveBeenCalledWith({ provider: "gitee", baseUrl: undefined, token: "gitee-token" });
    expect(stateSetters[2]).toHaveBeenCalledWith("");
    expect(stateSetters[5]).toHaveBeenCalledWith("已连接 Gitee 账号 @radar-user。");
    expect(refreshMock).toHaveBeenCalledOnce();
    expect(stateSetters[3].mock.calls.map(([value]) => value)).toEqual([true, false]);
  });

  it("saves self-hosted provider details and surfaces failures", async () => {
    stateValues[1] = "https://git.example.com";
    stateValues[2] = "gitlab-token";
    saveMock.mockRejectedValue(new Error("denied"));
    await submit("self-hosted");
    expect(saveMock).toHaveBeenCalledWith({ provider: "gitlab", baseUrl: "https://git.example.com", token: "gitlab-token" });
    expect(stateSetters[4]).toHaveBeenLastCalledWith("denied");
    expect(refreshMock).not.toHaveBeenCalled();
    expect(stateSetters[3].mock.calls.map(([value]) => value)).toEqual([true, false]);
  });
});
