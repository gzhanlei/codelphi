import { describe, expect, it } from "vitest";
import { connectionStatusLabel, hasProductCredentials, integrationFeedback, integrationMessageClass, manifestCallbackPath, patPresentation, parseConnectionId } from "../lib/integration-ui";

describe("integration presentation models", () => {
  it("resolves feedback and callback destinations", () => {
    const messages = { connected: "已连接", failed: "失败" };
    expect(integrationFeedback(undefined, "connected", messages)).toEqual({ text: "已连接", isError: false });
    expect(integrationFeedback("failed", undefined, messages)).toEqual({ text: "失败", isError: true });
    expect(integrationFeedback(undefined, undefined, messages)).toEqual({ text: undefined, isError: false });
    expect(integrationFeedback("", "connected", messages)).toEqual({ text: undefined, isError: false });
    expect(manifestCallbackPath(null)).toBe("/integrations/github/install");
    expect(manifestCallbackPath("conversion_failed")).toBe("/integrations?error=conversion_failed");
  });

  it("resolves connection and credential presentation", () => {
    expect(connectionStatusLabel("active")).toBe("已连接");
    expect(connectionStatusLabel("disconnected")).toBe("已断开");
    expect(integrationMessageClass(true)).toBe("integration-message error");
    expect(integrationMessageClass(false)).toBe("integration-message success");
    expect(hasProductCredentials([], false)).toBe(false);
    expect(hasProductCredentials([{ id: 1 }], false)).toBe(true);
    expect(hasProductCredentials([], true)).toBe(true);
    expect(patPresentation(true)).toMatchObject({ className: "connection-status active", label: "已配置", disabled: false });
    expect(patPresentation(false)).toMatchObject({ className: "connection-status disconnected", label: "未配置", disabled: true });
  });

  it("normalizes connection select inputs", () => {
    expect(patPresentation(true).optionLabel).toBe("Personal Access Token 回退");
    expect(patPresentation(false).optionLabel).toBe("选择 GitHub App 安装");
    expect(parseConnectionId("9")).toBe(9);
    expect(parseConnectionId("")).toBeNull();
  });
});
