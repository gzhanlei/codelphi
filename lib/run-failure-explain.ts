/**
 * 分析失败的用户友好解释（纯函数，视图层安全）。
 *
 * 背景（2026-11-12 用户反馈）：analysis_runs.error_message 存的是技术现场（zod JSON、
 * 堆栈头部——生产排障唯一现场），原样渲染到产品页对用户是噪音。页面只展示人话；技术
 * 详情的去向由 lib/run-failure-report.ts 负责（GitHub issue 自动上报）。
 */

export type RunFailureClass =
  | "ai_output_format"
  | "db_schema"
  | "timeout"
  | "network"
  | "credential"
  | "superseded"
  | "unknown";

export interface RunFailureExplanation {
  /** 页面展示的人话（含下一步动作指引）。 */
  userMessage: string;
  /** 技术类别：GitHub issue 标题签名与去重的依据。 */
  technicalClass: RunFailureClass;
  /** 是否值得自动报 GitHub issue（被更新的分析取代不是技术故障）。 */
  reportable: boolean;
}

/**
 * 分类依据是 error_message 的开头部分（message + 堆栈头部拼接，zod 错误是多行 JSON）。
 * 匹配按类别特异性排序：superseded → ai_output_format → db_schema → credential →
 * timeout → network → unknown 兜底。
 */
export function explainRunFailure(errorMessage: string): RunFailureExplanation {
  const head = (errorMessage ?? "").slice(0, 500);

  if (/Analysis superseded by run/i.test(head)) {
    return {
      userMessage: "本次分析已被更新的分析取代，无需处理。",
      technicalClass: "superseded",
      reportable: false,
    };
  }
  // zod 失败是多行 JSON 数组（pretty-printed），JSON.parse 类错误是一句话。
  if (/^\s*\[/.test(head) && /"code":\s*"invalid_/.test(head) || /did not contain a JSON object|Unexpected token/i.test(head)) {
    return {
      userMessage: "AI 返回的数据结构不符合预期格式。技术详情已自动上报，可直接重新发起分析。",
      technicalClass: "ai_output_format",
      reportable: true,
    };
  }
  if (/Unknown column|ER_BAD_FIELD_ERROR|ER_NO_SUCH_TABLE|Base table or view not found/i.test(head)) {
    return {
      userMessage: "数据库结构版本落后于代码，管理员已收到上报，稍后重试即可。",
      technicalClass: "db_schema",
      reportable: true,
    };
  }
  if (/Access denied|unauthorized|forbidden|401|403|invalid api key|TOKEN_ENCRYPTION/i.test(head)) {
    return {
      userMessage: "访问凭证无效或被拒绝，请检查集成配置。技术详情已自动上报。",
      technicalClass: "credential",
      reportable: true,
    };
  }
  if (/TimeoutError|AbortError|timeout|timed out/i.test(head)) {
    return {
      userMessage: "分析请求超时。可直接重新发起分析；若持续失败会继续上报。",
      technicalClass: "timeout",
      reportable: true,
    };
  }
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|network/i.test(head)) {
    return {
      userMessage: "连接模型服务或代码托管失败，通常是瞬时网络问题，可直接重试。",
      technicalClass: "network",
      reportable: true,
    };
  }
  return {
    userMessage: "分析过程中发生意外错误，技术详情已自动上报。",
    technicalClass: "unknown",
    reportable: true,
  };
}

/**
 * issue 去重签名：同类同因的失败共用一个 issue。zod 错误取首个 issue 的 path+code
 * （run 289 形态 → `ai_output_format: features/invalid_type`）；其余取首行前 120 字符。
 */
export function runFailureSignature(errorMessage: string): string {
  const { technicalClass } = explainRunFailure(errorMessage);
  const head = (errorMessage ?? "").slice(0, 500);
  let detail: string;
  if (technicalClass === "ai_output_format") {
    const path = head.match(/"path":\s*\[\s*"([^"]+)"/)?.[1] ?? "unknown_path";
    const code = head.match(/"code":\s*"([^"]+)"/)?.[1] ?? "unknown_code";
    detail = `${path}/${code}`;
  } else {
    detail = head.split("\n", 1)[0]?.trim().slice(0, 120) || "no-detail";
  }
  return `${technicalClass}: ${detail}`;
}
