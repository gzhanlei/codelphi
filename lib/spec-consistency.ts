/**
 * W0-9 · 规格一致性核验（纯函数）：同一功能内，同一错误/状态码 token 在一条场景里
 * 被「不再」否定、在另一条场景里被肯定陈述——枚举提取的多通道产出可能语义矛盾并存
 * （生产实测：L12「创建不再因 MissingOAuth2TokenError 返回 422」与「返回
 * MissingOAuth2TokenError」同规格并存）。检出不改写规格，输出冲突对供人工核实与
 * 一致性告警（产品定位：AI 翻译 + 人工核实签发）。
 */

export interface ConsistencyScenario {
  reference: string;
  outcome: string;
}

export interface OutcomeConflict {
  feature: string;
  token: string;
  negated: ConsistencyScenario;
  affirmative: ConsistencyScenario;
}

/** 提取结果陈述中的错误/状态码 token：XxxError 标识符与 3 位 HTTP 状态码。 */
function errorTokens(outcome: string): string[] {
  const tokens = new Set<string>();
  for (const match of outcome.matchAll(/\b[A-Z][A-Za-z0-9]*Error\b/g)) tokens.add(match[0]);
  for (const match of outcome.matchAll(/\b[45]\d{2}\b/g)) tokens.add(match[0]);
  return [...tokens];
}

/** 「不再」紧邻 token（中间无句读）→ 否定性陈述（修改后的行为：不再发生）；
 *  「不再重试，直接返回 504」这类否定的是别的动作（重试）不算。 */
function isNegated(outcome: string, token: string): boolean {
  const index = outcome.indexOf(token);
  if (index === -1) return false;
  const window = outcome.slice(Math.max(0, index - 16), index);
  const at = window.lastIndexOf("不再");
  if (at === -1) return false;
  const between = window.slice(at + "不再".length);
  return !/[。；！？→，、]/.test(between);
}

export function detectOutcomeConflicts(features: Array<{ name: string; scenarios: ConsistencyScenario[] }>): OutcomeConflict[] {
  const conflicts: OutcomeConflict[] = [];
  for (const feature of features) {
    const byToken = new Map<string, { negated: ConsistencyScenario; affirmative: ConsistencyScenario }>();
    for (const scenario of feature.scenarios) {
      for (const token of errorTokens(scenario.outcome)) {
        const entry = byToken.get(token) ?? {};
        if (isNegated(scenario.outcome, token)) entry.negated ??= scenario;
        else entry.affirmative ??= scenario;
        byToken.set(token, entry);
      }
    }
    for (const [token, entry] of byToken) {
      if (entry.negated && entry.affirmative) {
        conflicts.push({ feature: feature.name, token, negated: entry.negated, affirmative: entry.affirmative });
      }
    }
  }
  return conflicts;
}
