import { describe, expect, it } from "vitest";
import { classifySpecHighlight, SPEC_HIGHLIGHT_TYPES, type SpecChangeHighlightInput } from "../lib/spec-highlights";

const change = (overrides: Partial<SpecChangeHighlightInput> = {}): SpecChangeHighlightInput => ({
  entityType: "scenario",
  kind: "changed",
  featureName: "统一登录",
  summary: "登录成功跳转 dashboard",
  before: { context: "未登录", action: "提交邮箱密码", outcome: "登录成功" },
  after: { context: "未登录", action: "提交邮箱密码", outcome: "登录成功" },
  ...overrides,
});

describe("classifySpecHighlight", () => {
  it("covers exactly the nine spec types", () => {
    expect(SPEC_HIGHLIGHT_TYPES).toEqual(["Heads-up", "Pricing", "Limits", "Privacy", "Security", "Access", "Integrations", "Beta", "News"]);
  });

  it("tags security tightening as Security (superset sample: auth method tightened)", () => {
    const result = classifySpecHighlight(change({
      featureName: "认证",
      summary: "Password policy tightened: minimum length raised from 8 to 12 and breached-password checks added",
      after: { context: "c", action: "a", outcome: "password must be 12 chars and checked against breach list" },
    }));
    expect(result?.type).toBe("Security");
    expect(result?.reason.length ?? 0).toBeGreaterThan(0);
  });

  it("tags access-scope changes as Access (superset sample: admin permission change)", () => {
    const result = classifySpecHighlight(change({
      featureName: "Roles",
      summary: "Only workspace admins can now invite members",
      after: { context: "c", action: "invite a member", outcome: "requires the admin role" },
    }));
    expect(result).toEqual({ type: "Access", reason: expect.any(String) });
  });

  it("tags feature-flag wording as Beta (annotation only, not a claim of flag detection)", () => {
    const result = classifySpecHighlight(change({
      featureName: "报表导出",
      summary: "New async export flow behind the EXPORT_V2 feature flag (experimental preview)",
      kind: "added",
    }));
    expect(result).toEqual({ type: "Beta", reason: expect.stringContaining("flag") });
  });

  it("tags pricing, quota and integration wording (one class per change, first match wins)", () => {
    expect(classifySpecHighlight(change({ summary: "Price of the pro plan increased to $29" }))?.type).toBe("Pricing");
    expect(classifySpecHighlight(change({ summary: "API rate limit reduced to 100 requests per minute" }))?.type).toBe("Limits");
    expect(classifySpecHighlight(change({ summary: "Slack webhook integration now supports interactive messages" }))?.type).toBe("Integrations");
    expect(classifySpecHighlight(change({ summary: "Telemetry now collects anonymized usage data for privacy review" }))?.type).toBe("Privacy");
  });

  it("tags Heads-up from removals even without breaking wording", () => {
    const result = classifySpecHighlight(change({ featureName: "旧版导出", summary: "Legacy CSV export removed", kind: "removed" }));
    expect(result?.type).toBe("Heads-up");
  });

  it("tags News for new features that match nothing more specific", () => {
    const result = classifySpecHighlight(change({ featureName: "周报摘要", summary: "Weekly progress digest page added", kind: "added", entityType: "feature" }));
    expect(result?.type).toBe("News");
  });

  it("leaves ordinary behavior changes untagged (most changes carry no highlight)", () => {
    expect(classifySpecHighlight(change())).toBeNull();
    expect(classifySpecHighlight(change({ summary: "导出失败时提示改为红色文案" }))).toBeNull();
  });

  it("never leaves an empty reason when tagging", () => {
    for (const sample of [
      change({ summary: "Pricing tier renamed" }),
      change({ featureName: "旧版导出", summary: "removed", kind: "removed" }),
    ]) {
      const result = classifySpecHighlight(sample);
      expect(result?.reason?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
