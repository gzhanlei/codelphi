import { describe, expect, it, vi } from "vitest";
import { buildEnhancePrompt, buildFeatureCopyPrompt, buildHeadlinePrompt, buildLeadPrompt, parseFeatureCopy, rewriteReleaseNoteCopy } from "../lib/release-notes-enhance";

describe("bilingual release-note copy prompts (EN output mode)", () => {
  it("renders enhance/headline/feature-copy/lead prompts in English", () => {
    const enhance = buildEnhancePrompt({ kind: "added", featureName: "Login", scenarioReference: "HP-1", summary: "s", highlightType: null, emphasis: "", instruction: "" }, "en");
    expect(enhance).toContain("Write in English");
    expect(enhance).toContain("[Original] Added Login · HP-1");

    const headline = buildHeadlinePrompt({ releaseTitle: "v1", bullets: ["one", "two"] }, "en");
    expect(headline).toContain("Write one announcement headline for a product release. Write in English.");
    expect(headline).toContain("[Release entries]");

    const featureCopy = buildFeatureCopyPrompt({ featureName: "Login", emphasis: "", summaries: ["a", "b"] }, "en");
    expect(featureCopy).toContain("Write in English");
    expect(featureCopy).toContain("Added / Improved / Fixed / Removed");
    expect(featureCopy).toContain('"section":"Added|Improved|Fixed|Removed"');

    const lead = buildLeadPrompt({ releaseSummary: "s" }, "en");
    expect(lead).toContain("Rewrite the release summary below into a user-readable lead paragraph. Write in English.");
  });

  it("keeps the zh prompts byte-identical", () => {
    const featureCopy = buildFeatureCopyPrompt({ featureName: "登录", emphasis: "", summaries: ["a"] }, "zh-CN");
    expect(featureCopy).toContain("你在为一次产品发布撰写『功能更新说明』。用简体中文。");
    expect(featureCopy).toContain("新增 / 改进 / 修复 / 移除");
    const headline = buildHeadlinePrompt({ releaseTitle: "", bullets: ["x"] }, "zh-CN");
    expect(headline).toContain("为一次产品发布写一条公告标题。用简体中文。");
  });

  it("maps English section names to the canonical zh storage values", () => {
    expect(parseFeatureCopy('{"section":"Added","text":"t"}')).toEqual({ section: "新增", text: "t" });
    expect(parseFeatureCopy('{"section":"Improved","text":"t"}')).toEqual({ section: "改进", text: "t" });
    expect(parseFeatureCopy('{"section":"Fixed","text":"t"}')).toEqual({ section: "修复", text: "t" });
    expect(parseFeatureCopy('{"section":"Removed","text":"t"}')).toEqual({ section: "移除", text: "t" });
    expect(parseFeatureCopy('{"section":"Skipped","text":"t"}')).toEqual({ section: "省略", text: "t" });
    expect(parseFeatureCopy('{"section":"新增","text":"t"}')).toEqual({ section: "新增", text: "t" });
    expect(() => parseFeatureCopy('{"section":"其他","text":"t"}')).toThrow();
  });

  it("orchestrates the whole copy pipeline in English with bilingual system prompts", async () => {
    const completions: string[] = [];
    const completion = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      completions.push(messages[0].content);
      if (messages[0].content.includes("merges internal change records")) {
        return '{"section":"Added","text":"Users can now sign in with passkeys"}';
      }
      if (messages[0].content.includes("output only a compliant headline")) {
        return '{"headline":"Passkey sign-in arrives"}';
      }
      return '{"text":"Passkeys are now supported for sign-in"}';
    });
    const updates: unknown[][] = [];
    const outcome = await rewriteReleaseNoteCopy(
      { execute: async (sql, params) => { updates.push(params as unknown[]); } },
      { completion },
      {
        noteId: 1,
        releaseTitle: "v1",
        emphasis: "",
        releaseSummary: "Internal summary",
        groups: [{ featureName: "Login", blocks: [{ kind: "added", featureName: "Login", summary: "passkeys" }] }],
      },
      "en",
    );
    expect(outcome).toEqual({ features: 1, failed: 0, lead: "Passkeys are now supported for sign-in", headline: "Passkey sign-in arrives" });
    expect(completions[0]).toContain("You are a product announcements editor");
    expect(completions[1]).toContain("output only a compliant headline");
    expect(completions[2]).toContain("You are a product announcements editor");
    expect(JSON.parse(String(updates[0]?.[0]))).toEqual([{ feature: "Login", section: "新增", text: "Users can now sign in with passkeys" }]);
  });
});
