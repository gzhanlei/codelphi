/**
 * 流程图空态的人话解释（零依赖视图模块，客户端组件可安全 import）。
 * 输入为护栏拒绝码（spec_feature_flows.last_error_code），输出为面向用户的中文说明。
 * 原则：解释「为什么没有图」而不是暴露内部错误码；结尾都指回场景清单入口。
 */
const FLOW_ERROR_REASONS: Record<string, string> = {
  MAIN_CHAIN_MISSING:
    "这个功能的场景之间没有形成可表达的先后主链——这类功能（如仪表盘、清单、管理面板）能力是并列的，没有真实的执行顺序。强行画图会制造假流程，所以按证据护栏不渲染；完整场景清单见「场景」标签。",
  TOO_MANY_ENTRIES:
    "这个功能包含超过 8 条真正独立的子流程，超出单张流程图的承载范围，更适合拆分后分别生成；完整场景清单见「场景」标签。",
  TOO_MANY_NODES:
    "这个功能的场景规模超出单张流程图的表达上限（最多 24 个节点），完整场景清单见「场景」标签。",
  TOO_MANY_EDGES:
    "这个功能的关系数量超出单张流程图的表达上限（最多 48 条边），完整场景清单见「场景」标签。",
  RETRY_EVIDENCE_MISSING:
    "图中出现了重试/返回步骤，但现有场景证据不足以支持它，按证据校验暂不渲染；下次分析会自动重试生成。",
  INVALID_GRAPH_SHAPE:
    "AI 生成的图结构未通过校验（多为瞬时问题），下次分析会自动重试生成。",
  UNCONDITIONAL_ERROR_ENTRY:
    "场景证据不支持从入口直接进入错误处理，按证据校验暂不渲染；完整场景清单见「场景」标签。",
  EXCLUDED_SCENARIO_IN_GRAPH:
    "AI 把已排除的场景又画进了图里，未通过一致性校验；下次分析会自动重试生成。",
  UNKNOWN_SCENARIO_REFERENCE:
    "AI 引用了不存在的场景编号，未通过证据校验；下次分析会自动重试生成。",
  UNEXPECTED_CYCLE:
    "图中出现了证据不足以支持的循环依赖，按证据校验暂不渲染；完整场景清单见「场景」标签。",
  UNREACHABLE_NODE:
    "图中存在无法从入口到达的节点，未通过完整性校验；下次分析会自动重试生成。",
};

const FLOW_ERROR_FALLBACK = "AI 生成的流程图未通过证据校验，已按护栏要求不渲染未经证实的图；下次分析会自动重试生成，完整场景清单见「场景」标签。";

export function describeFeatureFlowEmptyState(errorCode?: string | null): string {
  if (!errorCode) return "流程图尚未生成，将随下次分析自动生成；完整场景清单见「场景」标签。";
  return FLOW_ERROR_REASONS[errorCode] ?? FLOW_ERROR_FALLBACK;
}
