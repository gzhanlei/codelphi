/**
 * 流程图空态的人话解释（零依赖视图模块，客户端组件可安全 import）。
 * 输入为护栏拒绝码（spec_feature_flows.last_error_code），输出为面向用户的说明。
 * 原则：解释「为什么没有图」而不是暴露内部错误码；结尾都指回场景清单入口。
 */
import { pick, type LocaleEntry, type UiLocale } from "./ui-locale";
import { FEATURE_FLOW } from "./ui-strings/product";

const FLOW_ERROR_REASONS = FEATURE_FLOW as Record<string, LocaleEntry>;

export function describeFeatureFlowEmptyState(errorCode?: string | null, locale: UiLocale = "zh-CN"): string {
  if (!errorCode) return pick(locale, FEATURE_FLOW.noError);
  const entry = FLOW_ERROR_REASONS[errorCode];
  return pick(locale, entry ?? FEATURE_FLOW.fallback);
}
