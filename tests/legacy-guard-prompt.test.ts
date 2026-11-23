import { describe, expect, it } from "vitest";
import { buildAnalysisMessages, type ChangeContext } from "../lib/ai";
import type { SourceFile } from "../lib/github";
import type { GuardAnchor } from "../lib/legacy-analysis/guard-anchors";
import {
  buildLegacyGuardExperimentMessages,
  type GuardExperimentArm,
} from "../lib/legacy-analysis/guard-prompt";

const SOURCES: SourceFile[] = [
  {
    path: "src/runs.ts",
    content: [
      "1: export async function runAnalysis(run: { id: string }, latestRunId: string) {",
      "2:   if (latestRunId !== run.id) throw new Error(\"Analysis superseded\");",
      "3:   return run;",
      "4: }",
    ].join("\n"),
  },
  {
    path: "src/billing.ts",
    content: [
      "1: export function charge(account: { quota: number }) {",
      "2:   if (account.quota <= 0) throw new Error(\"Quota exceeded\");",
      "3:   return debit(account);",
      "4: }",
    ].join("\n"),
  },
];

const CHANGE: ChangeContext = {
  message: "fix: keep stale-run guard visible",
  files: [{ path: "src/runs.ts", status: "modified", patch: "@@ -1,4 +1,4 @@ runAnalysis" }],
};

const ANCHORS: GuardAnchor[] = [
  {
    kind: "GUARD",
    path: "src/runs.ts",
    symbol: "runAnalysis",
    condition: "latestRunId !== run.id",
    outcome: "throw new Error(\"Analysis superseded\")",
    extraction: "complete",
    evidence: { path: "src/runs.ts", startLine: 2, endLine: 2 },
  },
  {
    kind: "GUARD",
    path: "src/billing.ts",
    symbol: "charge",
    condition: "account.quota <= 0",
    outcome: "throw new Error(\"Quota exceeded\")",
    extraction: "partial",
    evidence: { path: "src/billing.ts", startLine: 2, endLine: 2 },
  },
];

const ORIGINAL_COVERAGE = "当前产品功能规格必须覆盖输入代码里的全部主要用户功能，不得只总结本次提交。逐个检查输入中的页面、API、组件和业务模块；输入包含多个独立模块时，只返回一个功能属于不完整结果。";
const ORIGINAL_SCENARIO = "优先保证功能覆盖，每个功能保留最关键的 1-5 个场景；不要因单个功能场景过多而遗漏其他功能。";
const ORIGINAL_EVIDENCE = "每个场景、reviewed 审计候选和产品简介必须给 evidence；path 必须来自输入文件，startLine 使用输入的行号。没有内部实现需要审计时返回 changes=[]。";

const FROZEN_COVERAGE = "覆盖输入中的全部主要用户功能，逐个检查页面、API、组件和业务模块，不得只总结提交或遗漏独立模块。";
const FROZEN_SCENARIO = "覆盖全部主要功能；每功能保留 1-5 个关键场景。";
const FROZEN_EVIDENCE = "场景、审计候选和产品简介均须附输入文件的 path:startLine 证据；无内部审计时 changes=[]。";

const ANCHOR_HEADER = "【遗留守卫锚点";
const CODE_MARKER = "\n【当前代码，带行号】";
const COMMIT_MARKER = "【文件变化】";

function messages(arm: GuardExperimentArm, anchors: GuardAnchor[] = ANCHORS) {
  return buildLegacyGuardExperimentMessages({ arm, sources: SOURCES, change: CHANGE, anchors });
}

function userContent(arm: GuardExperimentArm, anchors: GuardAnchor[] = ANCHORS) {
  const user = messages(arm, anchors).find((message) => message.role === "user");
  if (!user) throw new Error("missing user message");
  return user.content;
}

function countOccurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

function codeSection(content: string) {
  const index = content.indexOf(CODE_MARKER);
  if (index < 0) throw new Error("missing code section");
  return content.slice(index);
}

function fileHeaders(content: string) {
  return [...content.matchAll(/^--- (.+) ---$/gm)].map((match) => match[1]).sort();
}

describe("legacy guard experiment prompt", () => {
  it("arm A is byte-identical to buildAnalysisMessages", () => {
    expect(messages("A")).toEqual(buildAnalysisMessages(SOURCES, CHANGE));
  });

  it("arm B applies only the three frozen replacements", () => {
    const a = userContent("A");
    const b = userContent("B");

    expect(b).toContain(FROZEN_COVERAGE);
    expect(b).toContain(FROZEN_SCENARIO);
    expect(b).toContain(FROZEN_EVIDENCE);
    expect(b).not.toContain(ORIGINAL_COVERAGE);
    expect(b).not.toContain(ORIGINAL_SCENARIO);
    expect(b).not.toContain(ORIGINAL_EVIDENCE);

    const reconstructed = a
      .replace(ORIGINAL_COVERAGE, FROZEN_COVERAGE)
      .replace(ORIGINAL_SCENARIO, FROZEN_SCENARIO)
      .replace(ORIGINAL_EVIDENCE, FROZEN_EVIDENCE);
    expect(b).toBe(reconstructed);

    expect(codeSection(b)).toBe(codeSection(a));
    expect(b).not.toContain(ANCHOR_HEADER);
  });

  it("arm C inserts anchors between commit and code without applying replacements", () => {
    const a = userContent("A");
    const c = userContent("C");

    expect(c).toContain(ORIGINAL_COVERAGE);
    expect(c).toContain(ORIGINAL_SCENARIO);
    expect(c).toContain(ORIGINAL_EVIDENCE);

    const anchorIndex = c.indexOf(ANCHOR_HEADER);
    expect(anchorIndex).toBeGreaterThan(c.indexOf(COMMIT_MARKER));
    expect(anchorIndex).toBeGreaterThan(-1);
    expect(anchorIndex).toBeLessThan(c.indexOf(CODE_MARKER));

    expect(c.slice(0, anchorIndex)).toBe(a.slice(0, a.indexOf(CODE_MARKER)) + "\n");
    expect(codeSection(c)).toBe(codeSection(a));

    const block = c.slice(anchorIndex, c.indexOf(CODE_MARKER));
    expect(block).toContain("extraction=complete");
    expect(block).toContain("extraction=partial");
    expect(block).not.toContain("resolution");

    for (const source of SOURCES) {
      expect(countOccurrences(c, source.content)).toBe(1);
    }
    expect(fileHeaders(c)).toEqual(fileHeaders(a));
  });

  it("arm D applies both the frozen replacements and the anchor insertion", () => {
    const b = userContent("B");
    const d = userContent("D");

    expect(d).toContain(FROZEN_COVERAGE);
    expect(d).toContain(FROZEN_SCENARIO);
    expect(d).toContain(FROZEN_EVIDENCE);
    expect(d).not.toContain(ORIGINAL_COVERAGE);
    expect(d).not.toContain(ORIGINAL_SCENARIO);
    expect(d).not.toContain(ORIGINAL_EVIDENCE);

    const anchorIndex = d.indexOf(ANCHOR_HEADER);
    expect(anchorIndex).toBeGreaterThan(d.indexOf(COMMIT_MARKER));
    expect(anchorIndex).toBeLessThan(d.indexOf(CODE_MARKER));
    expect(d.slice(0, anchorIndex)).toBe(b.slice(0, b.indexOf(CODE_MARKER)) + "\n");
    expect(codeSection(d)).toBe(codeSection(b));
  });

  it("caps anchors at three and orders by frozen score, then path, then startLine", () => {
    const anchors: GuardAnchor[] = [
      {
        kind: "GUARD", path: "src/z.ts", symbol: "symLatestZ",
        condition: "latestRunId !== run.id", outcome: "throw new Error(\"stale\")",
        extraction: "complete", evidence: { path: "src/z.ts", startLine: 5, endLine: 5 },
      },
      {
        kind: "GUARD", path: "src/a.ts", symbol: "symLatestA",
        condition: "!isLatest(run)", outcome: "throw new Error(\"stale\")",
        extraction: "complete", evidence: { path: "src/a.ts", startLine: 9, endLine: 9 },
      },
      {
        kind: "GUARD", path: "src/m.ts", symbol: "symPerm",
        condition: "!hasPermission(user)", outcome: "throw new Error(\"forbidden\")",
        extraction: "partial", evidence: { path: "src/m.ts", startLine: 2, endLine: 2 },
      },
      {
        kind: "GUARD", path: "src/q.ts", symbol: "symQuota",
        condition: "quotaExceeded(account)", outcome: "throw new Error(\"quota\")",
        extraction: "complete", evidence: { path: "src/q.ts", startLine: 3, endLine: 3 },
      },
      {
        kind: "GUARD", path: "src/n.ts", symbol: "symPlain",
        condition: "x > 1", outcome: "throw new Error(\"boom\")",
        extraction: "complete", evidence: { path: "src/n.ts", startLine: 1, endLine: 1 },
      },
    ];
    const c = userContent("C", anchors);
    const block = c.slice(c.indexOf(ANCHOR_HEADER), c.indexOf(CODE_MARKER));

    expect(block).toContain("symLatestA");
    expect(block).toContain("symLatestZ");
    expect(block).toContain("symPerm");
    expect(block).not.toContain("symQuota");
    expect(block).not.toContain("symPlain");

    expect(block.indexOf("symLatestA")).toBeLessThan(block.indexOf("symLatestZ"));
    expect(block.indexOf("symLatestZ")).toBeLessThan(block.indexOf("symPerm"));
  });
});
