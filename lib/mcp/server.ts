import { searchSpec } from "../spec-search";
import { loadFeatureConnections } from "../feature-connections";
import { loadCoverageReceipt } from "../analysis-coverage";
import { loadCompletenessLedgerBySpecVersion } from "../completeness-ledger";
import { defaultExecute, type Execute } from "../db";
import type { McpKeyIdentity } from "./api-keys";

/**
 * 稳定键解析内联版（与 lib/stable-links.ts 同语义）。2026-11-10 生产事故：各 route bundle
 * 共享同一个 webpack 运行时注册表，模块 id 撞车时 c() 会拿到其他 bundle 注册的旧拷贝，
 * 行为随加载顺序漂移（get_scenario 稳定返回空）。内联进 server.ts 后随本路由整体打包，
 * 不再经过共享注册表。stable_key → 最新 spec 版本条目 → 活跃 live 条目，缺失返回 null。
 */
function specFeatureKey(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function latestSpecFeatureName(stableKey: string, productId: number, execute: Execute) {
  const [rows] = await execute(
    `SELECT sf.name, sf.spec_version_id AS specVersionId
     FROM spec_features sf
     JOIN spec_versions v ON v.id = sf.spec_version_id
     JOIN repositories r ON r.id = v.repository_id
     WHERE sf.stable_key = ? AND r.product_id = ?
     ORDER BY sf.spec_version_id DESC
     LIMIT 1`,
    [stableKey, productId],
  ) as [Array<{ name: string; specVersionId: number }>, unknown];
  return rows[0] ?? null;
}

async function resolveFeatureByStableKey(productId: number, stableKey: string, execute: Execute): Promise<number | null> {
  const specFeature = await latestSpecFeatureName(stableKey, productId, execute);
  if (!specFeature) return null;
  const [rows] = await execute(
    "SELECT f.id FROM features f WHERE f.product_id = ? AND f.name = ? AND f.active = 1 LIMIT 1",
    [productId, specFeature.name],
  ) as [Array<{ id: number }>, unknown];
  return rows[0] ? Number((rows[0] as { id: number }).id) : null;
}

/**
 * 返回场景行 id（注意与 lib/stable-links.ts 的 resolveScenarioByStableKey 不同：
 * 那个返回 live feature id，规格场景页依赖该语义；本工具面需要的是场景行本身）。
 */
async function resolveScenarioRowId(productId: number, stableKey: string, reference: string, execute: Execute): Promise<number | null> {
  const specFeature = await latestSpecFeatureName(stableKey, productId, execute);
  if (!specFeature) return null;
  const [rows] = await execute(
    `SELECT s.id FROM scenarios s JOIN features f ON f.id = s.feature_id
     WHERE f.product_id = ? AND f.name = ? AND f.active = 1 AND s.active = 1 AND s.reference = ?
     LIMIT 1`,
    [productId, specFeature.name, reference],
  ) as [Array<{ id: number }>, unknown];
  return rows[0] ? Number((rows[0] as { id: number }).id) : null;
}

/**
 * A1 MCP server 的只读工具面（docs/specsight-gap-improvement-plan.md §4.1）。
 * 作用域：API key 的组织。越权（产品不属于该组织）一律返回空结果而非报错，防枚举。
 * 每个返回项带 stable link 与 evidence blob 链接——相对竞品的差异化，不得省略。
 * 工具集没有创建项目 / 编辑场景 / 邀请成员 / 改账单 / 发布 release notes 的能力。
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDef[] = [
  { name: "list_projects", description: "列出当前工作区（API key 所属组织）的全部产品", inputSchema: { type: "object", properties: {} } },
  { name: "get_project_summary", description: "产品概要：描述、功能/场景计数、最新证据覆盖率、最新发布", inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] } },
  { name: "get_feature", description: "按稳定键取功能及其场景（含证据链接）", inputSchema: { type: "object", properties: { slug: { type: "string" }, stableKey: { type: "string" } }, required: ["slug", "stableKey"] } },
  { name: "get_scenario", description: "按功能稳定键 + 场景引用取单个场景（含证据链接）", inputSchema: { type: "object", properties: { slug: { type: "string" }, stableKey: { type: "string" }, reference: { type: "string" } }, required: ["slug", "stableKey", "reference"] } },
  { name: "search_scenarios", description: "按关键词检索规格原文（命中条目 = 已过证据校验的原文，未覆盖时明确返回空）", inputSchema: { type: "object", properties: { slug: { type: "string" }, query: { type: "string" } }, required: ["slug", "query"] } },
  { name: "list_releases", description: "列产品的发布（时间倒序，默认 10 条）", inputSchema: { type: "object", properties: { slug: { type: "string" }, limit: { type: "number" } }, required: ["slug"] } },
  { name: "get_release", description: "单条发布的行为变化清单（含前后差异摘要与证据链接）", inputSchema: { type: "object", properties: { slug: { type: "string" }, releaseId: { type: "number" } }, required: ["slug", "releaseId"] } },
  { name: "get_feature_connections", description: "功能间的确定性连接（共享证据文件面；每条带依据文件清单，无 LLM 推断）", inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] } },
  { name: "get_release_notes", description: "单条发布的人工发布稿（块级、含 override 后文案与证据路径；未生成返回空）", inputSchema: { type: "object", properties: { slug: { type: "string" }, releaseId: { type: "number" } }, required: ["slug", "releaseId"] } },
  { name: "get_digest", description: "最近一期周期行为摘要（滚动 7 天分桶：support/sales/marketing；无则返回空）", inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] } },
  { name: "send_feedback", description: "向产品方发送使用反馈（只写反馈表，无其他写权限）", inputSchema: { type: "object", properties: { slug: { type: "string" }, kind: { type: "string", enum: ["bug", "question", "suggestion"] }, message: { type: "string" } }, required: ["slug", "kind", "message"] } },
];

interface RpcRequest { jsonrpc: string; id?: string | number | null; method: string; params?: Record<string, unknown> }
interface RpcResult { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

export interface McpRuntime {
  execute?: Execute;
  /** API key（keyId）或 OAuth token（grantId/userId）身份，工具面只用 organizationId 做作用域。 */
  identity: { organizationId: number; keyId?: number; userId?: number; grantId?: number };
}

function rpcError(id: RpcRequest["id"], code: number, message: string): RpcResult {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function rpcOk(id: RpcRequest["id"], result: unknown): RpcResult {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

async function resolveOrgProduct(execute: Execute, organizationId: number, slug: string) {
  const rows = await queryRows<{ id: number; slug: string; name: string; description: string }>(
    execute("SELECT id, slug, name, description FROM products WHERE organization_id = ? AND slug = ?", [organizationId, slug]),
  );
  return rows[0] ?? null;
}

async function resolveEvidenceSource(execute: Execute, productId: number) {
  const repos = await queryRows<{ provider: string; owner: string; name: string; defaultBranch: string; sha: string | null }>(
    execute(
      `SELECT r.provider, r.owner, r.name, r.default_branch AS defaultBranch, latest.after_sha AS sha
     FROM repositories r
     LEFT JOIN (SELECT repository_id, after_sha FROM analysis_runs WHERE status = 'succeeded' ORDER BY id DESC) latest ON latest.repository_id = r.id
     WHERE r.product_id = ? LIMIT 1`,
      [productId],
    ),
  );
  const repo = repos[0];
  if (!repo) return null;
  const blobUrl = (path: string, startLine?: number) => {
    if (repo.provider !== "github" || !repo.sha) return null;
    return `https://github.com/${repo.owner}/${repo.name}/blob/${repo.sha}/${path}${startLine ? `#L${startLine}` : ""}`;
  };
  return { repo, blobUrl };
}

function decorateEvidence(evidence: unknown, source: Awaited<ReturnType<typeof resolveEvidenceSource>>) {
  const items = Array.isArray(evidence) ? evidence : [];
  return items.map((item) => {
    const record = item as { path?: string; startLine?: number };
    return {
      path: record.path,
      startLine: record.startLine ?? null,
      url: source && record.path ? source.blobUrl(record.path, record.startLine) : null,
    };
  });
}

async function callTool(runtime: McpRuntime, name: string, args: Record<string, unknown>): Promise<unknown> {
  const execute = runtime.execute ?? defaultExecute;
  const slug = typeof args.slug === "string" ? args.slug : "";

  if (name === "list_projects") {
    const projects = await queryRows<{ slug: string; name: string; description: string }>(
      execute("SELECT slug, name, description FROM products WHERE organization_id = ? ORDER BY name", [runtime.identity.organizationId]),
    );
    return { projects };
  }

  const product = await resolveOrgProduct(execute, runtime.identity.organizationId, slug);
  if (!product) return {}; // 越权 / 不存在：返回空结果而非报错（防枚举）
  const source = await resolveEvidenceSource(execute, product.id);

  if (name === "get_project_summary") {
    const featureCounts = await queryRows<{ count: number }>(execute("SELECT COUNT(*) AS count FROM features WHERE product_id = ? AND active = 1", [product.id]));
    const releaseRows = await queryRows<{ id: number; title: string; sha: string; committedAt: Date; specVersionId: number | null }>(
      execute("SELECT id, title, sha, committed_at AS committedAt, spec_version_id AS specVersionId FROM releases WHERE product_id = ? ORDER BY committed_at DESC LIMIT 1", [product.id]),
    );
    const latestRelease = releaseRows[0] ?? null;
    const coverage = latestRelease?.specVersionId ? await loadCoverageReceipt(execute as unknown as (sql: string, params?: unknown[]) => Promise<unknown>, latestRelease.specVersionId) : null;
    // R1 分析完整性账本（run 级 best-effort，历史版本为 null）
    const completeness = latestRelease?.specVersionId ? await loadCompletenessLedgerBySpecVersion(execute as unknown as (sql: string, params?: unknown[]) => Promise<unknown>, latestRelease.specVersionId) : null;
    return {
      slug: product.slug,
      name: product.name,
      description: product.description,
      featureCount: Number(featureCounts[0]?.count ?? 0),
      latestRelease: latestRelease ? { id: latestRelease.id, title: latestRelease.title, sha: latestRelease.sha, committedAt: latestRelease.committedAt } : null,
      evidenceCoverage: coverage,
      completeness: completeness ? {
        overall: completeness.overall,
        sourceCoverage: completeness.sourceCoverage,
        behavioralEnumeration: completeness.behavioralEnumeration,
        extractionCompletion: completeness.extractionCompletion,
        evidenceIntegrity: completeness.evidenceIntegrity,
        mergeIntegrity: completeness.mergeIntegrity,
        verification: completeness.verification,
      } : null,
    };
  }

  if (name === "get_feature") {
    const stableKey = specFeatureKey(String(args.stableKey ?? ""));
    const featureId = await resolveFeatureByStableKey(product.id, stableKey, execute);
    if (featureId === null) return {};
    const features = await queryRows<{ id: number; name: string; summary: string; source: string }>(
      execute("SELECT id, name, summary, source FROM features WHERE id = ? AND product_id = ? AND active = 1", [featureId, product.id]),
    );
    const feature = features[0];
    if (!feature) return {};
    const scenarios = await queryRows<{ reference: string; context: string; action: string; outcome: string; category: string; source: string; evidence: unknown }>(
      execute("SELECT reference, context, action, outcome, category, source, evidence FROM scenarios WHERE feature_id = ? AND active = 1 ORDER BY reference", [featureId]),
    );
    return {
      feature: { name: feature.name, summary: feature.summary, source: feature.source, stablePath: `${product.slug}/spec/feature/${encodeURIComponent(stableKey)}` },
      scenarios: scenarios.map((scenario) => ({ ...scenario, evidence: decorateEvidence(scenario.evidence, source) })),
    };
  }

  if (name === "get_scenario") {
    const stableKey = specFeatureKey(String(args.stableKey ?? ""));
    const reference = String(args.reference ?? "");
    const scenarioId = await resolveScenarioRowId(product.id, stableKey, reference, execute);
    if (scenarioId === null) return {};
    const scenarios = await queryRows<{ reference: string; context: string; action: string; outcome: string; category: string; source: string; evidence: unknown; featureName: string }>(
      execute(
        "SELECT s.reference, s.context, s.action, s.outcome, s.category, s.source, s.evidence, f.name AS featureName FROM scenarios s JOIN features f ON f.id = s.feature_id WHERE s.id = ? AND s.active = 1",
        [scenarioId],
      ),
    );
    const scenario = scenarios[0];
    if (!scenario) return {};
    return { scenario: { ...scenario, evidence: decorateEvidence(scenario.evidence, source) } };
  }

  if (name === "search_scenarios") {
    return searchSpec(product.id, String(args.query ?? ""), execute);
  }

  if (name === "list_releases") {
    const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 50);
    const releases = await queryRows<{ id: number; title: string; summary: string; sha: string; url: string; committedAt: Date }>(
      execute("SELECT id, title, summary, sha, url, committed_at AS committedAt FROM releases WHERE product_id = ? ORDER BY committed_at DESC LIMIT ?", [product.id, limit]),
    );
    return { releases };
  }

  if (name === "get_release") {
    const releaseId = Number(args.releaseId ?? 0);
    const releases = await queryRows<{ id: number; title: string; summary: string; sha: string; url: string; committedAt: Date }>(
      execute("SELECT id, title, summary, sha, url, committed_at AS committedAt FROM releases WHERE id = ? AND product_id = ?", [releaseId, product.id]),
    );
    const release = releases[0];
    if (!release) return {};
    const changes = await queryRows<{ kind: string; entityType: string; featureName: string; scenarioReference: string; summary: string; highlightType: string | null; beforeJson: unknown; afterJson: unknown }>(
      execute(
        `SELECT c.kind, c.entity_type AS entityType, c.feature_name AS featureName, c.scenario_reference AS scenarioReference,
              c.summary, c.highlight_type AS highlightType, c.before_json AS beforeJson, c.after_json AS afterJson
       FROM spec_changes c JOIN releases r ON r.spec_version_id = c.spec_version_id
       WHERE r.id = ? AND c.wording_only = 0 ORDER BY c.id`,
        [release.id],
      ),
    );
    return {
      release,
      changes: changes.map((change) => ({
        ...change,
        before: change.beforeJson,
        after: change.afterJson,
        beforeJson: undefined,
        afterJson: undefined,
      })),
    };
  }

  if (name === "get_feature_connections") {
    return { connections: await loadFeatureConnections(execute, product.id) };
  }

  if (name === "get_release_notes") {
    const releaseId = Number(args.releaseId ?? 0);
    const notes = await queryRows<{ id: number; status: string; emphasis: string; shareToken: string | null; publishedAt: Date | null }>(
      execute("SELECT id, status, emphasis, share_token AS shareToken, published_at AS publishedAt FROM release_notes WHERE release_id = ? AND product_id = ?", [releaseId, product.id]),
    );
    const note = notes[0];
    if (!note) return {};
    const blocks = await queryRows<{ position: number; kind: string; featureName: string; scenarioReference: string; summary: string; summaryOverride: string | null; highlightType: string | null; beforeJson: unknown; afterJson: unknown }>(
      execute(
        `SELECT b.position, c.kind, c.feature_name AS featureName, c.scenario_reference AS scenarioReference,
              c.summary, b.summary_override AS summaryOverride, c.highlight_type AS highlightType,
              c.before_json AS beforeJson, c.after_json AS afterJson
       FROM release_note_blocks b JOIN spec_changes c ON c.id = b.spec_change_id
       WHERE b.release_note_id = ? ORDER BY b.position`,
        [note.id],
      ),
    );
    return {
      status: note.status,
      emphasis: note.emphasis,
      publishedAt: note.publishedAt,
      publicUrl: note.status === "published" && note.shareToken ? `/share/notes/${note.shareToken}` : null,
      blocks: blocks.map((block) => ({
        position: Number(block.position),
        kind: block.kind,
        featureName: block.featureName,
        scenarioReference: block.scenarioReference,
        // 人工改写优先（与公开页同口径）；summary 锚定 spec_change
        summary: (block.summaryOverride ?? "").trim() || block.summary,
        overridden: Boolean((block.summaryOverride ?? "").trim()),
        highlightType: block.highlightType,
        evidencePaths: [
          ...evidencePathsFromSubject(block.beforeJson),
          ...evidencePathsFromSubject(block.afterJson),
        ],
      })),
    };
  }

  if (name === "get_digest") {
    const digests = await queryRows<{ periodStart: string; periodEnd: string; contentJson: unknown; createdAt: Date }>(
      execute("SELECT period_start AS periodStart, period_end AS periodEnd, content_json AS contentJson, created_at AS createdAt FROM digests WHERE product_id = ? ORDER BY period_start DESC LIMIT 1", [product.id]),
    );
    const digest = digests[0];
    if (!digest) return {};
    let content: { period?: { start: string; end: string }; changes?: Array<Record<string, unknown>>; audiences?: Record<string, Array<Record<string, unknown>>> } = {};
    try {
      content = typeof digest.contentJson === "string" ? JSON.parse(digest.contentJson) : (digest.contentJson as typeof content);
    } catch {
      return {};
    }
    return {
      period: content.period ?? null,
      changes: content.changes ?? [],
      audienceCounts: Object.fromEntries(Object.entries(content.audiences ?? {}).map(([key, value]) => [key, value.length])),
    };
  }

  if (name === "send_feedback") {
    // feedback_reports 与会话用户耦合（createFeedbackReport 需要 SessionUser），
    // API key 身份直写：reporter_user_id 置 NULL，消息进 error_message（该表无独立 message 列）。
    const kind = String(args.kind ?? "question");
    const message = String(args.message ?? "").slice(0, 5000);
    const insertResult = await insertResultOf(
      execute(
        `INSERT INTO feedback_reports (organization_id, product_id, repository_full_name, revision, error_message)
       SELECT ?, ?, COALESCE(CONCAT(r.provider, ':', r.owner, '/', r.name), 'unknown'), COALESCE(latest.after_sha, ''), ?
       FROM products p
       LEFT JOIN repositories r ON r.product_id = p.id
       LEFT JOIN (SELECT repository_id, after_sha FROM analysis_runs WHERE status = 'succeeded' ORDER BY id DESC) latest ON latest.repository_id = r.id
       WHERE p.id = ? LIMIT 1`,
        [runtime.identity.organizationId, product.id, `[mcp:${kind}] ${message}`, product.id],
      ),
    );
    return { feedbackId: Number(insertResult.insertId) };
  }

  throw new Error(`Unknown tool: ${name}`);
}

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** 从 before/after JSON 的场景 evidence 抽证据路径（与 release notes 生成路由同口径）。 */
function evidencePathsFromSubject(subject: unknown): string[] {
  if (typeof subject !== "object" || subject === null) return [];
  const scenarios = (subject as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(scenarios)) return [];
  return scenarios.flatMap((scenario) => {
    const evidence = (scenario as { evidence?: unknown }).evidence;
    if (!Array.isArray(evidence)) return [];
    return evidence.map((item) => String((item as { path?: string }).path ?? "")).filter(Boolean);
  });
}

/** 取行辅助：Execute 返回 unknown（mysql2 元组 [rows, fields]；测试 mock 可能直接给行数组）。 */
async function queryRows<T>(promise: Promise<unknown>): Promise<T[]> {
  const result = (await promise) as unknown;
  if (!Array.isArray(result)) return [];
  const first = result[0];
  if (Array.isArray(first)) return first as T[];
  return result as T[];
}

/** 取单个 insert 结果（mysql2 ResultSetHeader 或测试 mock 的 { insertId }）。 */
async function insertResultOf(promise: Promise<unknown>): Promise<{ insertId: number }> {
  const result = (await promise) as unknown;
  const first = Array.isArray(result) ? result[0] : result;
  return (first ?? { insertId: 0 }) as { insertId: number };
}

/** 单条 JSON-RPC 分发（纯逻辑，HTTP 层在 route.ts）。 */
export async function handleMcpRpc(runtime: McpRuntime, request: RpcRequest): Promise<RpcResult | null> {
  // 通知（无 id）不回包
  if (request.id === undefined || request.id === null) return null;
  if (request.method === "initialize") {
    return rpcOk(request.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "codelphi-mcp", version: "0.1.0" },
    });
  }
  if (request.method === "tools/list") {
    return rpcOk(request.id, { tools: MCP_TOOLS });
  }
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((item) => item.name === name);
    if (!tool) return rpcError(request.id, METHOD_NOT_FOUND, `Unknown tool: ${name}`);
    try {
      const result = await callTool(runtime, name, args);
      return rpcOk(request.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 参数类错误与内部错误区分码；消息不含密钥与内部路径
      const code = /required|invalid|must/i.test(message) ? INVALID_PARAMS : INTERNAL_ERROR;
      return rpcError(request.id, code, message.slice(0, 300));
    }
  }
  return rpcError(request.id, METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
}
