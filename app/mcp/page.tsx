import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { CopyBlock } from "@/components/copy-block";
import { PublicShell } from "@/components/public-shell";
import { getSessionUser } from "@/lib/session";
import { appUrl } from "@/lib/env";
import { mcpServersJson } from "@/lib/mcp/connect-configs";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const locale = await resolveUiLocale();
  return { title: locale === "en" ? "MCP connection guide" : "MCP 连接指南" };
}

/**
 * 用户级常驻指令段（门控生效）：贴一次 ~/.zcode/AGENTS.md（ZCode）或 ~/.claude/CLAUDE.md（Claude Code），
 * 所有仓库生效——门控条件不满足（未连接 codelphi MCP / remote 匹配不到）时自动跳过。
 * 与 lib/mcp/server.ts 的 initialize.instructions 内容保持一致口径。
 */
const WORKFLOW_AGENTS_SNIPPET = `## 行为账本（CoDelphi MCP）——门控生效

凡会话中可见 mcp__codelphi__ 前缀工具，且当前仓库 git remote 能在 list_projects 结果中按 owner/name 匹配到产品（slug 取匹配值），即本仓库已接入 CoDelphi 行为账本，自觉执行下述约定；工具不可用或匹配不到时本段不适用，直接跳过：

- 做计划时（早于任何文件改动）：lookup_by_files 反查计划要改的文件的爆炸半径，把回归红线场景与 push 后对账锚点写进计划；必要时 get_feature_connections(path) 看共享邻域。方案已定但未反查 = 计划未完成，不得动手。
- 需要理解既有行为时：search_scenarios 检索规格原文，用返回的 stableKey 深入 get_feature，不要只靠读代码猜约定。
- push 后：list_releases 找到本次 sha 对应的发布，get_release 核对行为变化清单 ⊆ 本次意图；计划外的变化回查并向用户报告。
- 发现账本与代码不符：send_feedback 上报，AI 裁决管线自动核实处置（确认缺陷即触发修复性重建，误报驳回），仅证据不足的进入人工队列；账本是只读面，「没搜到 ≠ 不存在」。`;

const TOOL_GROUPS_ZH: Array<{ heading: string; tools: Array<{ name: string; desc: string }> }> = [
  {
    heading: "产品与规格",
    tools: [
      { name: "list_projects", desc: "列出工作区内的产品" },
      { name: "get_project_summary", desc: "产品概要：描述、功能/场景计数、证据覆盖率、最新发布" },
      { name: "get_feature", desc: "按稳定键取功能及其全部场景（含证据链接）" },
      { name: "get_scenario", desc: "按功能稳定键 + 场景引用取单个场景" },
      { name: "search_scenarios", desc: "按关键词检索规格原文（已过证据校验）" },
      { name: "lookup_by_files", desc: "按文件路径反查哪些功能/场景以它为证据（改前影响面）" },
      { name: "get_feature_connections", desc: "功能间的确定性连接（共享证据文件面）" },
      { name: "get_knowledge_health", desc: "知识健康事实统计（漂移/核实覆盖/回归四态）" },
    ],
  },
  {
    heading: "发布",
    tools: [
      { name: "list_releases", desc: "列产品的发布（时间倒序，per-push 一条）" },
      { name: "get_release", desc: "单条发布的行为变化清单（push 后对账用）" },
      { name: "get_release_notes", desc: "单条发布的人工发布稿" },
      { name: "get_digest", desc: "最近一期周期行为摘要（滚动 7 天分桶）" },
    ],
  },
  {
    heading: "反馈（唯一写入口）",
    tools: [
      { name: "send_feedback", desc: "发现账本与代码不符时上报，AI 裁决管线自动核实处置（确认缺陷触发修复性重建，误报驳回），仅证据不足的进入人工队列；账本本身只读" },
    ],
  },
];

const TOOL_GROUPS_EN: Array<{ heading: string; tools: Array<{ name: string; desc: string }> }> = [
  {
    heading: "Products & spec",
    tools: [
      { name: "list_projects", desc: "List products in the workspace" },
      { name: "get_project_summary", desc: "Product summary: description, feature/scenario counts, evidence coverage, latest release" },
      { name: "get_feature", desc: "Get a feature and all its scenarios by stable key (with evidence links)" },
      { name: "get_scenario", desc: "Get one scenario by feature stable key + scenario reference" },
      { name: "search_scenarios", desc: "Search spec wording by keyword (evidence-verified)" },
      { name: "lookup_by_files", desc: "Reverse-lookup which features/scenarios cite a file path (pre-change blast radius)" },
      { name: "get_feature_connections", desc: "Deterministic connections between features (shared evidence files)" },
      { name: "get_knowledge_health", desc: "Knowledge-health fact stats (drift / verification coverage / regression states)" },
    ],
  },
  {
    heading: "Releases",
    tools: [
      { name: "list_releases", desc: "List releases (newest first, one per push)" },
      { name: "get_release", desc: "One release's behavior-change list (for post-push reconciliation)" },
      { name: "get_release_notes", desc: "One release's human-authored release notes" },
      { name: "get_digest", desc: "Latest periodic behavior digest (rolling 7-day buckets)" },
    ],
  },
  {
    heading: "Feedback (the only write tool)",
    tools: [
      { name: "send_feedback", desc: "Report ledger-vs-code mismatches — the AI adjudication pipeline verifies automatically (confirmed defects trigger corrective rebuilds, false alarms are dismissed); only evidence-insufficient cases reach the human queue. The ledger itself is read-only" },
    ],
  },
];

/** 英文版工作流指令段：与中文段同一治理内容（MCP instructions 本身保持中文口径）。 */
const WORKFLOW_AGENTS_SNIPPET_EN = `## Behavior ledger (CoDelphi MCP) — gated

Whenever tools prefixed mcp__codelphi__ are visible in a session AND the current repository's git remote matches a product in list_projects (use the matching slug), this repository is connected to the CoDelphi behavior ledger; follow the rules below on your own. When the gate does not hold (MCP not connected / remote unmatched), skip this section entirely:

- When planning (before any file edit): run lookup_by_files against the files you plan to change to map the blast radius; put regression red-line scenarios and post-push reconciliation anchors into the plan; use get_feature_connections(path) for the shared neighborhood when needed. A plan without the reverse lookup is incomplete — do not start editing.
- To understand existing behavior: search_scenarios to retrieve spec wording (with stableKey and evidence line numbers) instead of guessing from code.
- After a push: list_releases to find the release for this sha, get_release to verify the change list is within your intent; investigate unexpected changes and report them to the user.
- When the ledger disagrees with the code: report with send_feedback — the AI adjudication pipeline verifies automatically (confirmed defects trigger corrective rebuilds, false alarms are dismissed); only evidence-insufficient cases reach the human queue. The ledger is read-only, and "no search hit" does not mean "does not exist".`;

/** MCP 连接指南（公开页）：coding agent 用 API key + 通用 mcpServers JSON；ChatGPT/Claude Web 连接器走 OAuth 自动发现。 */
export default async function McpGuidePage() {
  const user = await getSessionUser();
  const locale = await resolveUiLocale();
  const t = (zh: string, en: string) => (locale === "en" ? en : zh);
  const base = appUrl();
  const endpoint = `${base}/api/mcp`;
  const configJson = mcpServersJson(endpoint);
  const TOOL_GROUPS = locale === "en" ? TOOL_GROUPS_EN : TOOL_GROUPS_ZH;
  const snippet = locale === "en" ? WORKFLOW_AGENTS_SNIPPET_EN : WORKFLOW_AGENTS_SNIPPET;
  const page = (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">MCP</span><h1>{t("连接 CoDelphi MCP", "Connect the CoDelphi MCP")}</h1><p>{t("把你的产品行为账本接入 coding agent：改代码前查影响面，push 后对账行为变化，让 AI 助手引用带证据的产品事实。", "Wire your product behavior ledger into your coding agent: check blast radius before edits, reconcile behavior changes after pushes, and let AI assistants cite evidence-backed product facts.")}</p></div>
      </div>

      <section className="overview-panel">
        <h2>{t("一、拿一个只读 key", "1. Get a read-only key")}</h2>
        <p>{t("登录后到 ", "Sign in and open the ")}<Link href="/settings">{t("设置页 · MCP 集成", "Settings · MCP integration")}</Link>{t(" 签发组织级 API key（", " page to issue an organization-level API key (")}<code>sk_cd_…</code>{t("，明文只显示一次）。key 是组织级只读凭证，撤销后立即失效。", "; shown in plaintext once). The key is an organization-level read-only credential and stops working immediately when revoked.")}</p>
      </section>

      <section className="overview-panel">
        <h2>{t("二、写入你的 coding agent", "2. Add it to your coding agent")}</h2>
        <p>{t("端点：", "Endpoint: ")}<code>{endpoint}</code>{t("（Streamable HTTP，Authorization: Bearer 认证）。通用 mcpServers 配置（把占位符换成你的 key，或直接在设置页签发后复制烤好的版本）：", " (Streamable HTTP, Authorization: Bearer auth). Generic mcpServers config (replace the placeholder with your key, or copy the baked version from the settings page):")}</p>
        <CopyBlock label={t("通用 mcpServers JSON", "Generic mcpServers JSON")} text={configJson} locale={locale} />
        <ul className="mcp-guide-notes">
          <li>{t("Claude Code：存为项目根目录 ", "Claude Code: save as ")}<code>.mcp.json</code>{t("，或执行 ", " in the project root, or run ")}<code>claude mcp add --transport http codelphi {endpoint} --header "Authorization: Bearer &lt;key&gt;"</code></li>
          <li>{t("ZCode：", "ZCode: ")}<code>~/.zcode/cli/config.json</code>{t(" 的 ", " under ")}<code>mcp.servers</code>{t("（服务器对象同形状；团队共享可放仓库 ", " (same server-object shape; for team sharing put it in the repository ")}<code>.zcode/config.json</code>{t("）", ")")}</li>
          <li>Cursor: <code>~/.cursor/mcp.json</code> ({t("同样的 mcpServers 形状", "same mcpServers shape")})</li>
          <li>{t("接入验证：在 agent 里问「列出我的 CoDelphi 产品」，应触发 list_projects 返回本工作区产品", "Sanity check: ask your agent to list your CoDelphi products — it should trigger list_projects and return the products of the current workspace")}</li>
        </ul>
      </section>

      <section className="overview-panel">
        <h2>{t("三、ChatGPT / Claude 网页版连接器（OAuth）", "3. ChatGPT / Claude web connectors (OAuth)")}</h2>
        <p>{t("网页端连接器不走静态 key，走 OAuth 自动发现：添加自定义 MCP 连接器时填端点 ", "Web connectors do not use a static key — they use OAuth auto-discovery: when adding a custom MCP connector, enter the endpoint ")}<code>{endpoint}</code>{t("，连接器会自动读取发现元数据并跳转本站授权页；你人工批准后生效，token 由连接器自动续期（30 天不使用需重连）。", "; the connector reads the discovery metadata and redirects to the authorization page of this site. It activates once you approve, and the connector renews the token automatically (reconnect after 30 idle days).")}</p>
      </section>

      <section className="overview-panel">
        <h2>{t("四、工具面（13 个）", "4. Tool surface (13 tools)")}</h2>
        {TOOL_GROUPS.map((group) => (
          <div key={group.heading}>
            <h3>{group.heading}</h3>
            <ul className="mcp-guide-notes">
              {group.tools.map((tool) => (
                <li key={tool.name}><code>{tool.name}</code> — {tool.desc}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="overview-panel">
        <h2>{t("五、给 agent 的工作流约定", "5. Workflow rules for your agent")}</h2>
        <ul className="mcp-guide-notes">
          <li>{t("动手改文件前：用 lookup_by_files 反查要改的文件是哪些功能/场景的证据（爆炸半径）", "Before editing files: use lookup_by_files to reverse-lookup which features/scenarios cite them (blast radius)")}</li>
          <li>{t("需要理解既有行为：用 search_scenarios 检索规格原文，别只靠读代码猜约定", "To understand existing behavior: use search_scenarios for spec wording instead of guessing from code")}</li>
          <li>{t("push 后：用 list_releases 找到本次提交对应的发布，get_release 核对行为变化清单与意图一致", "After a push: use list_releases to find the release for this commit and get_release to verify the change list matches your intent")}</li>
          <li>{t("发现账本与代码不符：用 send_feedback 上报，AI 裁决管线自动核实处置（确认缺陷触发修复性重建，误报驳回），仅证据不足的进入人工队列；账本是只读面", "On ledger-vs-code mismatches: report with send_feedback — the AI adjudication pipeline verifies automatically (confirmed defects trigger corrective rebuilds, false alarms are dismissed); only evidence-insufficient cases reach the human queue. The ledger is read-only")}</li>
        </ul>
        <p>{t("让 agent 自觉执行以上约定，推荐贴进", "To make your agent follow these rules on its own, paste them into a ")}<strong>{t("用户级", "user-level")}</strong>{t("指令文件——每人一次，所有仓库生效（段内自带门控：未连接 codelphi MCP 或仓库匹配不到时自动跳过，不影响未接入的项目）：", " instruction file — once per person, effective across all repositories (the section carries its own gate: it skips automatically when the codelphi MCP is not connected or the remote does not match)")}</p>
        <CopyBlock label={t("用户级常驻指令段（贴进 ~/.zcode/AGENTS.md 或 ~/.claude/CLAUDE.md）", "User-level instruction snippet (paste into ~/.zcode/AGENTS.md or ~/.claude/CLAUDE.md)")} text={snippet} locale={locale} />
        <p>{t("团队想把规范共享给所有成员时，可再把同段贴进仓库根目录 ", "To share the rules with all team members, additionally paste the same snippet into the repository root ")}<code>AGENTS.md</code>{t("（可选加强，非必需）。已连接本服务的 agent 还会随连接收到一份相同的约定（MCP instructions），即使用户级文件未配置也有基本触发。", " (optional, not required). Agents connected to this service also receive the same rules through the connection itself (MCP instructions), so basic triggering works even without a user-level file.")}</p>
      </section>

      <p><Link href="/settings" className="text-button">{t("去设置页签发 key →", "Issue a key on the settings page →")}</Link></p>
      {!user ? <p><Link href="/" className="text-button">{t("← 返回产品总览", "← Back to products")}</Link></p> : null}
    </>
  );
  if (!user) return <PublicShell activeHref="/mcp">{page}</PublicShell>;
  return <AppShell user={user} activeHref="/mcp">{page}</AppShell>;
}
