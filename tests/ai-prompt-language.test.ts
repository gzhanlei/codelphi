import { describe, expect, it } from "vitest";
import {
  behavioralDescribePrompt,
  behavioralJudgmentPrompt,
  extractionInstructionLines,
  featureContinuitySection,
  incrementalScopeSection,
  partitionNotice,
  specAnchoringSection,
  systemPrompt,
  type ChangeContext,
} from "../lib/ai";

const change: ChangeContext = { message: "fix: retry", files: [{ path: "lib/auth.ts", status: "modified", patch: "" }] };

describe("bilingual prompt assembly (EN output mode)", () => {
  it("reserves zh extraction changes for reviewed audit candidates", () => {
    const lines = extractionInstructionLines("zh-CN", { coverageMandate: "当前产品功能规格必须覆盖输入代码里的全部主要用户功能" }).join("\n");
    expect(lines).toContain("你在维护一个产品知识库。仅根据给定代码和 diff 输出事实，不要补充猜测。");
    expect(lines).toContain("用简体中文生成：1) 产品简介；2) 当前产品功能规格。");
    expect(lines).toContain("changes 仅用于 kind=reviewed 的内部实现审计候选");
    expect(lines).not.toContain("3) 本次发布的用户可感知变化");
    expect(lines).toContain("禁止用 result 等同义键名");
    expect(lines).toContain("当前产品功能规格必须覆盖输入代码里的全部主要用户功能");
    expect(lines).toContain("只返回 JSON，不要 Markdown。结构：");
    expect(systemPrompt("zh-CN")).toBe("你是严谨的代码分析器，只输出可验证的结构化事实。");
  });

  it("produces English instructions that forbid Chinese output", () => {
    const lines = extractionInstructionLines("en", { coverageMandate: "cover every major capability" }).join("\n");
    expect(lines).toContain("Generate the following in English");
    expect(lines).toContain("never Chinese");
    expect(lines).toContain("cover every major capability");
    expect(lines).toContain("changes is reserved for kind=reviewed internal-implementation audit candidates");
    expect(lines).not.toContain("3) the user-perceivable changes of this release");
    expect(lines).toContain("Return JSON only, no Markdown. Structure:");
    expect(systemPrompt("en")).toMatch(/rigorous code analyzer/);
  });

  it("renders anchor, continuity, scope and partition sections in the requested language", () => {
    const anchorEn = specAnchoringSection(
      [{ name: "Login", summary: "OAuth sign-in", scenarios: [{ reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy" }] }],
      24_000,
      "en",
    );
    expect(anchorEn).toContain("reused verbatim");
    expect(anchorEn).toContain("Context: Visitor｜Action: Signs in｜Outcome: Dashboard");

    const anchorZh = specAnchoringSection(
      [{ name: "登录", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" }] }],
      24_000,
      "zh-CN",
    );
    expect(anchorZh).toContain("【上一版规格全文——行为未变的条目必须逐字沿用】");

    expect(featureContinuitySection(["登录"], "en")).toContain("keep naming continuous");
    expect(featureContinuitySection(["登录"], "zh-CN")).toContain("保持命名连续");

    const scope = incrementalScopeSection(["Login"], ["lib/new.ts"], "en");
    expect(scope).toContain("[Incremental analysis mode]");
    expect(scope).toContain("output it as an independent feature");
    expect(scope).toContain("lib/new.ts");
    expect(scope).toContain("Final release copy is composed once from canonical spec changes");

    expect(partitionNotice(2, 6, "en")).toContain("partition 2/6");
    expect(partitionNotice(2, 6, "zh-CN")).toContain("第 2/6 个分区");
  });

  it("renders the behavioral two-step prompts in English", () => {
    const targets = [{ path: "lib/auth.ts", patch: "@@ -1 +1 @@", contextBlocks: [{ startLine: 1, endLine: 2, content: "1: code" }] }];
    const describePrompt = behavioralDescribePrompt(targets, change, "en");
    expect(describePrompt).toContain("Restate only the facts");
    expect(describePrompt).toContain("Write in English");

    const judge = behavioralJudgmentPrompt(
      [{ path: "lib/auth.ts", hunk: "@@ -1 @@", before: "a", after: "b" }],
      targets,
      ["Login"],
      change,
      "en",
    );
    expect(judge).toContain("Judge every restatement explicitly");
    expect(judge).toContain("kind=reviewed");
    expect(judge).toContain("Prefer reusing these existing feature names");
  });

  it("keeps the zh behavioral prompts byte-identical", () => {
    const targets = [{ path: "lib/auth.ts", patch: "@@ -1 +1 @@", contextBlocks: [{ startLine: 1, endLine: 2, content: "1: code" }] }];
    expect(behavioralDescribePrompt(targets, change, "zh-CN")).toContain("你在向一位不了解此变更的工程师转述代码变更");
    expect(behavioralDescribePrompt(targets, change)).toContain("用简体中文");
    const judge = behavioralJudgmentPrompt([{ path: "lib/auth.ts", hunk: "@@ -1 @@", before: "a", after: "b" }], targets, ["登录"], change, "zh-CN");
    expect(judge).toContain("对每条复述显式判定并处理，不得遗漏任何一条");
  });
});
