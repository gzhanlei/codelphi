import { describe, expect, it } from "vitest";
import { answerSpecQuestion } from "../lib/spec-ask";
import type { Execute } from "../lib/db";

/** 与 tests/spec-ask.test.ts 同形状的规格切片：三个功能、四条场景。 */
const FEATURES = [
  { id: 1, name: "文件上传", summary: "上传附件，限制数量与大小" },
  { id: 2, name: "统一登录", summary: "OAuth 登录与会话" },
  { id: 3, name: "通知分发", summary: "Slack 与邮件通知" },
];
const SCENARIOS = [
  { id: 11, featureId: 1, featureName: "文件上传", reference: "HP-1", context: "用户在上传框选择附件", action: "一次选择不超过 10 个文件", outcome: "系统接受并进入上传队列", evidence: [{ path: "src/upload.ts", startLine: 42 }] },
  { id: 12, featureId: 1, featureName: "文件上传", reference: "EC-1", context: "单个文件超过 20MB", action: "继续上传", outcome: "系统拒绝并提示文件过大", evidence: [{ path: "src/upload.ts", startLine: 42 }] },
  { id: 21, featureId: 2, featureName: "统一登录", reference: "ER-1", context: "OAuth 回调失败", action: "重试登录", outcome: "显示错误信息并停留登录页", evidence: [{ path: "lib/auth.ts", startLine: 5 }] },
  { id: 31, featureId: 3, featureName: "通知分发", reference: "HP-1", context: "分析完成且存在行为变化", action: "触发通知", outcome: "Slack 与邮件各发送一次", evidence: [{ path: "lib/notifications.ts", startLine: 88 }] },
];

/** 模拟 MySQL LIKE：按参数里的检索词过滤，行为与 lib/spec-search.ts 的 SQL 一致。 */
const execute: Execute = async (statement, parameters) => {
  const pattern = String(parameters[1] ?? "");
  const term = pattern.slice(1, -1).replace(/\\(.)/g, "$1");
  const sql = String(statement);
  if (sql.includes("FROM features f")) {
    return [FEATURES.filter((feature) => `${feature.name}${feature.summary}`.includes(term))];
  }
  if (sql.includes("FROM scenarios s")) {
    return [SCENARIOS
      .filter((scenario) => `${scenario.reference}${scenario.featureName}${scenario.context}${scenario.action}${scenario.outcome}`.includes(term))
      .map((scenario) => ({ ...scenario, evidence: JSON.stringify(scenario.evidence) }))];
  }
  return [[]];
};

/** 规格确实覆盖的问法：来自三个功能的正常路径、边界与错误路径。 */
const IN_SCOPE = [
  "上传文件最多几个？",
  "一次能选择几个附件？",
  "文件上传超过 20MB 会怎样？",
  "单个文件过大时系统怎么提示？",
  "用户选择附件后系统怎么做？",
  "HP-1 文件上传的正常流程是什么？",
  "OAuth 回调失败会发生什么？",
  "登录失败会显示错误信息吗？",
  "重试登录之后停留在哪个页面？",
  "统一登录的错误路径是什么？",
  "分析完成且有行为变化会发通知吗？",
  "Slack 和邮件各发送几次？",
  "通知分发在什么情况下触发？",
  "行为变化会触发什么动作？",
  "文件上传的边界情况有哪些？",
];

/** 规格里完全没有的信息：产品政策、支付方式、合规、账单、集成。 */
const OUT_OF_SCOPE = [
  "怎么配置 SSO 单点登录？",
  "支持微信支付吗？",
  "数据保留多少天？",
  "如何申请退款？",
  "有没有 SOC 2 认证？",
];

describe("B2.1 acceptance: 20 preset questions", () => {
  it("refuses every out-of-scope question instead of guessing (100%)", async () => {
    const answers = await Promise.all(OUT_OF_SCOPE.map((question) => answerSpecQuestion(3, question, execute)));
    for (const answer of answers) {
      expect(answer).toMatchObject({ status: "uncovered", features: [], scenarios: [] });
      expect(answer.notice).toContain("未覆盖");
    }
  });

  it("still answers real questions with verbatim spec text, not a blanket refusal", async () => {
    const answers = await Promise.all(IN_SCOPE.map((question) => answerSpecQuestion(3, question, execute)));
    const matched = answers.filter((answer) => answer.status === "matched");
    // 探针指标：命中率随查询理解与规格文本一起变化，留作后续调优的基线。
    console.info(`[spec-ask] in-scope hit rate: ${matched.length}/${IN_SCOPE.length}`);
    // 下限护栏：若召回掉到这个数以下，说明查询理解把正常问句也挡掉了。
    expect(matched.length).toBeGreaterThanOrEqual(6);
    for (const answer of matched) {
      expect(answer.scenarios.length + answer.features.length).toBeGreaterThan(0);
      expect(answer.notice).toContain("规格原文");
    }
  });
});
