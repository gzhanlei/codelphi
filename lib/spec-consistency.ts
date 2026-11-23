/**
 * W0-9 · 规格一致性核验（纯函数）：同一功能内，同一错误/状态码 token 在一条场景里
 * 被「不再」否定、在另一条场景里被肯定陈述——枚举提取的多通道产出可能语义矛盾并存
 * （生产实测：L12「创建不再因 MissingOAuth2TokenError 返回 422」与「返回
 * MissingOAuth2TokenError」同规格并存）。检出不改写规格，输出冲突对供人工核实与
 * 一致性告警（产品定位：AI 翻译 + 人工核实签发）。
 */

import { isNegatedNearToken } from "./text-script";

export interface ConsistencyScenario {
  reference: string;
  outcome: string;
  context?: string;
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

/** 否定性陈述判定（双语）：中文「不再」/英文 no longer/not/never 紧邻 token（中间无句读）
 *  → 修改后的行为不再发生；「不再重试，直接返回 504」这类否定的是别的动作（重试）不算。 */
function isNegated(outcome: string, token: string): boolean {
  return isNegatedNearToken(outcome, token);
}

export function detectOutcomeConflicts(features: Array<{ name: string; scenarios: ConsistencyScenario[] }>): OutcomeConflict[] {
  const conflicts: OutcomeConflict[] = [];
  for (const feature of features) {
    const byToken = new Map<string, { negated?: ConsistencyScenario; affirmative?: ConsistencyScenario }>();
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


interface VisibilityStatement {
  token: string;
  negated: boolean;
}

function visibilityStatements(outcome: string): VisibilityStatement[] {
  const statements: VisibilityStatement[] = [];
  for (const clause of outcome.split(/[，,。；;]/)) {
    const match = /^(不)?(显示|渲染)(.+)$/.exec(clause.trim());
    if (!match) continue;
    const negated = match[1] === "不";
    const tokens = new Set<string>();
    const raw = match[3].trim();
    if (raw && !raw.includes("「")) tokens.add(raw);
    for (const quoted of raw.matchAll(/「([^」]+)」/g)) tokens.add(quoted[1]);
    for (const token of tokens) {
      const normalized = token.replace(/[「」『』"'\s]/g, "").replace(/(?:链接|按钮|提示|文案|CTA)$/i, "");
      if (normalized) statements.push({ token: normalized, negated });
    }
  }
  return statements;
}

function conditionKey(context: string): string {
  const normalized = context.trim().toLowerCase();
  const roles = [
    normalized.includes("匿名") ? "anonymous" : null,
    normalized.includes("只读") ? "readonly" : null,
    normalized.includes("编辑") ? "editor" : null,
    normalized.includes("管理员") || normalized.includes("owner") ? "owner" : null,
    normalized.includes("成员") ? "member" : null,
  ].filter((role): role is string => role !== null);
  return roles.length === 1 ? roles[0] : normalized.replace(/\s+/g, "");
}

export function hasModifiedVisibilityOutcome(previous: ConsistencyScenario, current: ConsistencyScenario): boolean {
  if (conditionKey(previous.context ?? "") !== conditionKey(current.context ?? "")) return false;
  const currentStatements = visibilityStatements(current.outcome);
  return visibilityStatements(previous.outcome).some((previousStatement) =>
    currentStatements.some((currentStatement) => previousStatement.token === currentStatement.token && previousStatement.negated !== currentStatement.negated),
  );
}

export function detectVisibilityConflicts(features: Array<{ name: string; scenarios: ConsistencyScenario[] }>): OutcomeConflict[] {
  const conflicts: OutcomeConflict[] = [];
  const byCondition = new Map<string, { feature: string; negated?: ConsistencyScenario; affirmative?: ConsistencyScenario }>();
  for (const feature of features) {
    for (const scenario of feature.scenarios) {
      const condition = conditionKey(scenario.context ?? "");
      if (!condition) continue;
      for (const statement of visibilityStatements(scenario.outcome)) {
        const key = `${condition}\n${statement.token}`;
        const existing = byCondition.get(key) ?? { feature: feature.name };
        if (statement.negated) existing.negated ??= scenario;
        else existing.affirmative ??= scenario;
        byCondition.set(key, existing);
      }
    }
  }
  for (const [key, entry] of byCondition) {
    if (entry.negated && entry.affirmative) {
      conflicts.push({ feature: entry.feature, token: key.split("\n")[1], negated: entry.negated, affirmative: entry.affirmative });
    }
  }
  return conflicts;
}
