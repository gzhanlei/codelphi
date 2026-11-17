import { z } from "zod";
import { defaultExecute, type Execute } from "./db";
import { requestStructuredCompletion, type LlmBillingContext } from "./ai";
import { queueAnalysis } from "./analysis";
import { getCodeHostingAdapter } from "./code-hosting";
import { createRemoteSourceIndex, defaultRemoteSourceBudgets } from "./remote-source-index";
import { getDb } from "./db";

/**
 * Feedback AI 自动裁决管线（2026-11-15 用户裁定：AI 裁决优先，人只兜底）。
 * 对 kind=bug 的账本不符报告：装配证据（报告主张 + 近期 spec_changes + 报告 revision
 * 处的证据文件代码）→ LLM 结构化裁决（zod + 一次修正重试）→ 处置：
 *   confirmed_defect + high 置信 → 触发修复性全量重建 run（queueAnalysis manual，
 *   继承全部护栏；AI 误删不会被 tombstone 拦，全量重提取从代码重新发现丢失行为）；
 *   false_alarm → 驳回留痕；needs_human → 证据不可得/低置信，进入人工队列。
 * 计费：裁决调用 receipt-only（runId:null, callKind='feedback_adjudication'）；
 * 修复 run 是标准 manual run（独立 1 SAU 计费，契约口径不变）。
 * 幂等：处置 UPDATE 带 verdict IS NULL guard，sweep 重跑天然重试。
 */

export const FEEDBACK_ADJUDICATION_THRESHOLD_MINUTES = 10;
export const FEEDBACK_ADJUDICATION_BATCH = 3;
const MAX_EVIDENCE_FILES = 5;
const EVIDENCE_FILE_LINES = 120;

export type FeedbackVerdict = "confirmed_defect" | "false_alarm" | "needs_human";

const adjudicationSchema = z.object({
  verdict: z.enum(["confirmed_defect", "false_alarm", "needs_human"]),
  confidence: z.enum(["high", "low"]),
  reason: z.string().min(1).max(2_000),
});

export type AdjudicationVerdict = z.infer<typeof adjudicationSchema>;

export interface AdjudicationChangeDigest {
  kind: string;
  entityType: string;
  featureName: string;
  scenarioReference: string | null;
  summary: string;
  evidencePaths: string[];
}

export interface AdjudicationCodeExcerpt {
  path: string;
  content: string;
}

/** 裁决 prompt（中文）：主张 + 近期账本变化摘要 + 报告 revision 处的代码证据。 */
export function buildAdjudicationPrompt(input: { claim: string; changes: AdjudicationChangeDigest[]; codeExcerpts: AdjudicationCodeExcerpt[] }): string {
  const changes = input.changes.length > 0
    ? input.changes.map((change) => `- [${change.kind}/${change.entityType}] ${change.featureName}${change.scenarioReference ? ` · ${change.scenarioReference}` : ""}：${change.summary}${change.evidencePaths.length > 0 ? `（证据：${change.evidencePaths.join("、")}）` : ""}`).join("\n")
    : "（近期账本无变化记录）";
  const code = input.codeExcerpts.length > 0
    ? input.codeExcerpts.map((excerpt) => `--- ${excerpt.path}（报告 revision 处的当前代码节选）---\n${excerpt.content}`).join("\n\n")
    : "（代码证据不可读取——请基于账本记录判断，并把 confidence 降为 low）";
  return [
    "你是 CoDelphi 行为账本的裁决器。一条报告主张「账本与代码不符」，请核实并给出裁决。",
    "裁决口径（宁缺毋滥——只有证据确凿才 confirm）：",
    "- confirmed_defect：报告属实，账本确实与代码不符（如：行为未变的场景被误删/误改，代码至今仍实现该行为）。",
    "- false_alarm：报告不成立（如：行为确实随代码变更而移除、主张引用的场景本来就不存在、报告误读了账本）。",
    "- needs_human：证据不足以让自动化裁决（如代码与账本都模糊、需要业务判断、涉及人工编辑的条目）。",
    "只有 confirmed_defect 且 confidence=high 才会触发修复性全量重建 run（重新提取整库规格，丢失的行为会从代码找回）；请勿轻易给出。",
    '只返回 JSON，不要 Markdown：{"verdict":"confirmed_defect|false_alarm|needs_human","confidence":"high|low","reason":"中文裁决理由，引用具体证据"}',
    "",
    `【报告主张】${input.claim}`,
    "",
    "【近期账本变化（最近两次发布的行为变化记录）】",
    changes,
    "",
    "【代码证据】",
    code,
  ].join("\n");
}

function unwrapJson(content: string): string {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 裁决输出不含 JSON 结构");
  return stripped.slice(start, end + 1);
}

export function parseAdjudicationVerdict(content: string): AdjudicationVerdict {
  return adjudicationSchema.parse(JSON.parse(unwrapJson(content)));
}

export interface AdjudicationDependencies {
  execute?: Execute;
  completion?: (messages: Array<{ role: string; content: string }>, billing?: LlmBillingContext) => Promise<string>;
  queueAnalysis?: typeof queueAnalysis;
  /** 读取报告 revision 处的证据文件内容；失败/缺省 = 代码证据不可得。 */
  readFile?: (path: string, revision: string) => Promise<string>;
}

interface AdjudicationReportRow {
  id: number;
  productId: number;
  repositoryId: number;
  revision: string;
  claim: string;
  kind: string;
}

async function loadReport(id: number, execute: Execute): Promise<AdjudicationReportRow | null> {
  const result = await execute(
    `SELECT f.id, f.product_id AS productId, r.id AS repositoryId, f.revision, f.error_message AS claim, f.kind
     FROM feedback_reports f JOIN repositories r ON r.product_id = f.product_id
     WHERE f.id = ? AND f.verdict IS NULL AND f.kind = 'bug' AND f.status = 'new'
     LIMIT 1`,
    [id],
  );
  const reportRows = (Array.isArray(result) ? result[0] : result ?? []) as AdjudicationReportRow[];
  return reportRows[0] ?? null;
}

/** 证据路径提取：spec_changes 的 before/after 主体可能是 feature 形状（scenarios[]）或场景形状（evidence[]）。 */
function parseJsonLoose(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function evidencePathsOf(subject: unknown): string[] {
  // mysql2 回传 JSON 列为字符串：先解析再按形状提取
  const body = typeof subject === "string" ? parseJsonLoose(subject) : subject;
  if (typeof body !== "object" || body === null) return [];
  const shaped = body as { scenarios?: unknown; evidence?: unknown };
  if (Array.isArray(shaped.scenarios)) {
    return (shaped.scenarios as Array<{ evidence?: unknown }>).flatMap((scenario) =>
      Array.isArray(scenario.evidence) ? (scenario.evidence as Array<{ path?: string }>).map((item) => String(item.path ?? "")).filter(Boolean) : [],
    );
  }
  if (Array.isArray(shaped.evidence)) {
    return (shaped.evidence as Array<{ path?: string }>).map((item) => String(item.path ?? "")).filter(Boolean);
  }
  return [];
}

async function loadRecentChanges(execute: Execute, productId: number): Promise<AdjudicationChangeDigest[]> {
  const result = await execute(
    `SELECT c.kind, c.entity_type AS entityType, c.feature_name AS featureName,
            c.scenario_reference AS scenarioReference, c.summary,
            c.before_json AS beforeJson, c.after_json AS afterJson
     FROM spec_changes c JOIN releases r ON r.spec_version_id = c.spec_version_id
     WHERE r.product_id = ? AND c.wording_only = 0
     ORDER BY r.committed_at DESC, c.id DESC LIMIT 40`,
    [productId],
  );
  const changeRows = (Array.isArray(result) ? result[0] : result ?? []) as Array<{ kind: string; entityType: string; featureName: string; scenarioReference: string | null; summary: string; beforeJson: unknown; afterJson: unknown }>;
  return changeRows.map((row) => ({
    kind: row.kind,
    entityType: row.entityType,
    featureName: row.featureName,
    scenarioReference: row.scenarioReference,
    summary: row.summary,
    evidencePaths: [...new Set([...evidencePathsOf(row.beforeJson), ...evidencePathsOf(row.afterJson)])],
  }));
}

async function loadLatestReleaseSha(execute: Execute, productId: number): Promise<{ sha: string; repositoryId: number } | null> {
  const result = await execute(
    "SELECT sha, repository_id AS repositoryId FROM releases WHERE product_id = ? ORDER BY committed_at DESC LIMIT 1",
    [productId],
  );
  const shaRows = (Array.isArray(result) ? result[0] : result ?? []) as Array<{ sha: string; repositoryId: number }>;
  const row = shaRows[0];
  return row ? { sha: row.sha, repositoryId: Number(row.repositoryId) } : null;
}

function collectEvidenceFiles(changes: AdjudicationChangeDigest[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) for (const path of change.evidencePaths) paths.add(path);
  return [...paths].slice(0, MAX_EVIDENCE_FILES);
}

const billing: LlmBillingContext = { runId: null, accountId: null, chargeComponent: "main", callKind: "feedback_adjudication" };

/** 生产默认代码证据读取器：按报告 revision 打开远端索引读证据文件（失败即证据不可得）。 */
async function createRevisionFileReader(execute: Execute, repositoryId: number, revision: string): Promise<(path: string) => Promise<string>> {
  const result = await execute(
    `SELECT r.provider, r.owner, r.name, r.connection_id AS connectionId, p.organization_id AS organizationId
     FROM repositories r JOIN products p ON p.id = r.product_id WHERE r.id = ? LIMIT 1`,
    [repositoryId],
  );
  const repo = ((Array.isArray(result) ? result[0] : result ?? []) as Array<{ provider: "github" | "gitlab" | "gitea" | "gitee"; owner: string; name: string; connectionId: number | null; organizationId: number }>)[0];
  if (!repo) throw new Error("feedback_adjudication_repository_missing");
  const adapter = getCodeHostingAdapter(repo.provider);
  const access = { connectionId: repo.connectionId, organizationId: repo.organizationId };
  const index = await createRemoteSourceIndex(
    { owner: repo.owner, repo: repo.name, revision },
    { scopeRoots: [], access, provider: adapter.provider, backend: adapter.createSourceBackend(access), budgets: defaultRemoteSourceBudgets },
  );
  return async (path: string) => {
    const slice = await index.readLines({ path, startLine: 1, endLine: EVIDENCE_FILE_LINES, requestedBy: "evidence_verifier", reason: "feedback adjudication code evidence" });
    return slice.lines.join("\n");
  };
}

export async function adjudicateFeedbackReport(id: number, deps: AdjudicationDependencies = {}): Promise<{ verdict: FeedbackVerdict; reason: string; correctiveRunId: number | null } | null> {
  const execute = deps.execute ?? defaultExecute;
  const report = await loadReport(id, execute);
  if (!report) return null;

  const changes = await loadRecentChanges(execute, report.productId);
  const evidenceFiles = collectEvidenceFiles(changes);
  const codeExcerpts: AdjudicationCodeExcerpt[] = [];
  try {
    const readFile = deps.readFile ?? (await createRevisionFileReader(execute, report.repositoryId, report.revision));
    for (const path of evidenceFiles) {
      try {
        codeExcerpts.push({ path, content: (await readFile(path, report.revision)).slice(0, 8_000) });
      } catch {
        // 单文件读取失败容忍：其余文件继续；全部失败按证据不可得降级
      }
    }
  } catch {
    // 索引装配失败（仓库不可达等）：代码证据整体不可得，降级 needs_human
  }
  // 护栏以「实际读到的代码证据」为准：零证据（清单为空或全部读取失败）时
  // confirm_defect 一律降级 needs_human，杜绝无证据的自动全量重建。
  const evidenceUnavailable = codeExcerpts.length === 0;

  const prompt = buildAdjudicationPrompt({ claim: report.claim, changes, codeExcerpts });
  const completion = deps.completion ?? requestStructuredCompletion;
  let verdict: AdjudicationVerdict;
  try {
    verdict = parseAdjudicationVerdict(await completion([{ role: "user", content: prompt }], billing));
  } catch (firstError) {
    // 一次修正重试（feature-flow 模式）：结构不合格完整重生成
    const content = await completion(
      [
        { role: "user", content: prompt },
        { role: "assistant", content: firstError instanceof Error ? `上次输出未通过校验：${firstError.message.slice(0, 200)}` : "上次输出未通过校验" },
        { role: "user", content: "请完整重新生成并修正，只返回 JSON：{\"verdict\":\"confirmed_defect|false_alarm|needs_human\",\"confidence\":\"high|low\",\"reason\":\"…\"}" },
      ],
      billing,
    );
    verdict = parseAdjudicationVerdict(content);
  }

  const finalVerdict: FeedbackVerdict =
    verdict.verdict === "confirmed_defect" && (verdict.confidence !== "high" || evidenceUnavailable) ? "needs_human" : verdict.verdict;

  let correctiveRunId: number | null = null;
  if (finalVerdict === "confirmed_defect") {
    const release = await loadLatestReleaseSha(execute, report.productId);
    if (release) {
      const queue = deps.queueAnalysis ?? queueAnalysis;
      // 纠偏 run 归属该发布所在的仓库（多仓库产品下按 product 任取会落在无关仓库）
      correctiveRunId = await queue(release.repositoryId, null, release.sha, "manual");
    } else {
      correctiveRunId = null;
    }
  }

  await execute(
    `UPDATE feedback_reports SET verdict = ?, verdict_reason = ?, adjudicated_at = CURRENT_TIMESTAMP(3), corrective_run_id = ?
     WHERE id = ? AND verdict IS NULL`,
    [finalVerdict, verdict.reason, correctiveRunId, id],
  );
  return { verdict: finalVerdict, reason: verdict.reason, correctiveRunId };
}

export interface FeedbackAdjudicationSweepOutcome {
  adjudicated: number;
  confirmed: number;
  dismissed: number;
  needsHuman: number;
}

/** 积压反馈裁决（feedback-adjudication sweep 周期入口）：每轮上限 BATCH 条，失败留原状下轮重试。 */
export async function runFeedbackAdjudicationSweepOnce(deps: AdjudicationDependencies = {}): Promise<FeedbackAdjudicationSweepOutcome> {
  const execute = deps.execute ?? defaultExecute;
  const result = await execute(
    `SELECT f.id FROM feedback_reports f
     WHERE f.status = 'new' AND f.verdict IS NULL AND f.kind = 'bug'
       AND f.created_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE)
     ORDER BY f.id LIMIT ?`,
    [FEEDBACK_ADJUDICATION_THRESHOLD_MINUTES, FEEDBACK_ADJUDICATION_BATCH],
  );
  const ids = ((Array.isArray(result) ? result[0] : result ?? []) as Array<{ id: number }>).map((row) => Number(row.id));
  const outcome: FeedbackAdjudicationSweepOutcome = { adjudicated: 0, confirmed: 0, dismissed: 0, needsHuman: 0 };
  for (const id of ids) {
    try {
      const result = await adjudicateFeedbackReport(id, deps);
      if (!result) continue;
      outcome.adjudicated += 1;
      if (result.verdict === "confirmed_defect") outcome.confirmed += 1;
      else if (result.verdict === "false_alarm") outcome.dismissed += 1;
      else outcome.needsHuman += 1;
    } catch (error) {
      console.warn("[feedback-adjudication] report adjudication failed; kept pending", {
        id,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
  }
  return outcome;
}
