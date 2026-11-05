import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TokenIntegrationCard } from "../components/token-integration-card";
import { GitHubAppCard } from "../components/github-app-card";
import { ConnectionActionButtons } from "../components/connection-action-buttons";
import { handleConnectionAction } from "../components/connection-actions";
import type { RepositoryConnectionState } from "../lib/repository-connections";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const connection: RepositoryConnectionState = {
  id: 9,
  provider: "gitee",
  displayName: "Radar 用户",
  accountLogin: "radar-user",
  baseUrl: "https://gitee.com",
  tokenHint: "····cret",
  status: "active",
  lastError: null,
  lastCheckedAt: null,
};

describe("repository connection setup UI", () => {
  it("guides Gitee setup without exposing saved credentials", () => {
    const html = renderToStaticMarkup(createElement(TokenIntegrationCard, { kind: "gitee", connections: [connection], canEdit: true }));
    expect(html).toContain("Gitee");
    expect(html).toContain("https://gitee.com/profile/personal_access_tokens");
    expect(html).toContain('type="password"');
    expect(html).toContain("验证并保存连接");
    expect(html).toContain("····cret");
    expect(html).toContain("重新检查");
    expect(html).toContain("删除连接");
    expect(html).toContain("添加产品和代码分析仍仅支持 GitHub");
    expect(html).not.toContain("gitee-secret");
  });

  it("supports self-managed GitLab and Gitea with HTTPS guidance", () => {
    const html = renderToStaticMarkup(createElement(TokenIntegrationCard, { kind: "self-hosted", connections: [], canEdit: true }));
    expect(html).toContain("GitLab（云端或自托管）");
    expect(html).toContain("Gitea");
    expect(html).toContain("https://git.example.com");
    expect(html).toContain("read_api");
    expect(html).toContain("REPOSITORY_HOST_ALLOWLIST");
  });

  it("keeps GitHub setup available to editors and read-only for viewers", () => {
    expect(renderToStaticMarkup(createElement(GitHubAppCard, { app: null, connections: [], canEdit: true }))).toContain("连接 GitHub");
    expect(renderToStaticMarkup(createElement(GitHubAppCard, { app: null, connections: [] }))).toContain("连接 GitHub");
    const html = renderToStaticMarkup(createElement(GitHubAppCard, {
      app: { slug: "radar-app" },
      connections: [{ id: 1, accountLogin: "radar-user", accountType: "User", status: "active", installationId: 42 }],
      canEdit: false,
    }));
    expect(html).toContain("radar-app");
    expect(html).toContain("radar-user");
    expect(html).toContain("1 个可用安装");
    expect(html).not.toContain("尚未安装到任何");
    expect(html).not.toContain("添加账号或组织");
    expect(html).not.toContain("重新检查");
  });

  it("links existing apps to their one-time push notification settings", () => {
    const html = renderToStaticMarkup(createElement(GitHubAppCard, { app: { slug: "radar-app" }, connections: [], canEdit: true }));
    expect(html).toContain("设置 Push 通知");
    expect(html).toContain("https://github.com/settings/apps/radar-app");
    expect(html).toContain("尚未安装到任何 GitHub 账号或组织");
  });

  it("keeps viewer workspaces read-only", () => {
    const html = renderToStaticMarkup(createElement(TokenIntegrationCard, { kind: "gitee", connections: [connection], canEdit: false }));
    expect(html).toContain("工作区查看者只能查看连接状态");
    expect(html).not.toContain("验证并保存连接");
    expect(html).not.toContain("断开连接");
  });

  it("disables every connection action while one is pending", () => {
    const html = renderToStaticMarkup(createElement(ConnectionActionButtons, { pending: "check", status: "active", kind: "repository", onRun: vi.fn() }));
    expect(html).toContain("检查中…");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("connection action controls", () => {
  function controls() {
    return {
      isPending: vi.fn(() => false),
      setPending: vi.fn(),
      setError: vi.fn(),
      confirmDelete: vi.fn(() => true),
      refresh: vi.fn(),
      runClient: vi.fn(async () => ({ status: "active" })),
    };
  }

  it("ignores re-entry and cancelled deletion", async () => {
    const pending = controls();
    pending.isPending.mockReturnValue(true);
    await handleConnectionAction(9, "check", "github", pending);
    expect(pending.runClient).not.toHaveBeenCalled();
    const cancelled = controls();
    cancelled.confirmDelete.mockReturnValue(false);
    await handleConnectionAction(9, "delete", "repository", cancelled);
    expect(cancelled.runClient).not.toHaveBeenCalled();
    expect(cancelled.setPending).not.toHaveBeenCalled();
  });

  it("refreshes after a successful action and always releases pending", async () => {
    const subject = controls();
    await handleConnectionAction(9, "delete", "repository", subject);
    expect(subject.runClient).toHaveBeenCalledWith(9, "delete", "repository");
    expect(subject.refresh).toHaveBeenCalledOnce();
    expect(subject.setPending.mock.calls).toEqual([["delete"], [""]]);
  });

  it("surfaces failures and still releases pending", async () => {
    const subject = controls();
    subject.runClient.mockRejectedValue(new Error("denied"));
    await handleConnectionAction(9, "check", "github", subject);
    expect(subject.setError).toHaveBeenLastCalledWith("denied");
    expect(subject.refresh).not.toHaveBeenCalled();
    expect(subject.setPending).toHaveBeenLastCalledWith("");
  });
});
