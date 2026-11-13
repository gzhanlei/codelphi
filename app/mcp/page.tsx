import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { CopyBlock } from "@/components/copy-block";
import { PublicShell } from "@/components/public-shell";
import { getSessionUser } from "@/lib/session";
import { appUrl } from "@/lib/env";
import { mcpServersJson } from "@/lib/mcp/connect-configs";

export const dynamic = "force-dynamic";

export const metadata = { title: "MCP 连接指南" };

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
- 发现账本与代码不符：send_feedback 上报由人裁决；账本是只读面，「没搜到 ≠ 不存在」。`;

const TOOL_GROUPS: Array<{ heading: string; tools: Array<{ name: string; desc: string }> }> = [
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
      { name: "send_feedback", desc: "发现账本与代码不符时上报，由人裁决；账本本身只读" },
    ],
  },
];

/** MCP 连接指南（公开页）：coding agent 用 API key + 通用 mcpServers JSON；ChatGPT/Claude Web 连接器走 OAuth 自动发现。 */
export default async function McpGuidePage() {
  const user = await getSessionUser();
  const base = appUrl();
  const endpoint = `${base}/api/mcp`;
  const configJson = mcpServersJson(endpoint);
  const page = (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">MCP</span><h1>连接 CoDelphi MCP</h1><p>把你的产品行为账本接入 coding agent：改代码前查影响面，push 后对账行为变化，让 AI 助手引用带证据的产品事实。</p></div>
      </div>

      <section className="overview-panel">
        <h2>一、拿一个只读 key</h2>
        <p>登录后到 <Link href="/settings">设置页 · MCP 集成</Link> 签发组织级 API key（<code>sk_cd_…</code>，明文只显示一次）。key 是组织级只读凭证，撤销后立即失效。</p>
      </section>

      <section className="overview-panel">
        <h2>二、写入你的 coding agent</h2>
        <p>端点：<code>{endpoint}</code>（Streamable HTTP，Authorization: Bearer 认证）。通用 mcpServers 配置（把占位符换成你的 key，或直接在设置页签发后复制烤好的版本）：</p>
        <CopyBlock label="通用 mcpServers JSON" text={configJson} />
        <ul className="mcp-guide-notes">
          <li>Claude Code：存为项目根目录 <code>.mcp.json</code>，或执行 <code>claude mcp add --transport http codelphi {endpoint} --header "Authorization: Bearer &lt;key&gt;"</code></li>
          <li>ZCode：<code>~/.zcode/cli/config.json</code> 的 <code>mcp.servers</code>（服务器对象同形状；团队共享可放仓库 <code>.zcode/config.json</code>）</li>
          <li>Cursor：<code>~/.cursor/mcp.json</code>（同样的 mcpServers 形状）</li>
          <li>接入验证：在 agent 里问「列出我的 CoDelphi 产品」，应触发 list_projects 返回本工作区产品</li>
        </ul>
      </section>

      <section className="overview-panel">
        <h2>三、ChatGPT / Claude 网页版连接器（OAuth）</h2>
        <p>网页端连接器不走静态 key，走 OAuth 自动发现：添加自定义 MCP 连接器时填端点 <code>{endpoint}</code>，连接器会自动读取发现元数据并跳转本站授权页；你人工批准后生效，token 由连接器自动续期（30 天不使用需重连）。</p>
      </section>

      <section className="overview-panel">
        <h2>四、工具面（13 个）</h2>
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
        <h2>五、给 agent 的工作流约定</h2>
        <ul className="mcp-guide-notes">
          <li>动手改文件前：用 lookup_by_files 反查要改的文件是哪些功能/场景的证据（爆炸半径）</li>
          <li>需要理解既有行为：用 search_scenarios 检索规格原文，别只靠读代码猜约定</li>
          <li>push 后：用 list_releases 找到本次提交对应的发布，get_release 核对行为变化清单与意图一致</li>
          <li>发现账本与代码不符：用 send_feedback 上报由人裁决；账本是只读面</li>
        </ul>
        <p>让 agent 自觉执行以上约定，推荐贴进<strong>用户级</strong>指令文件——每人一次，所有仓库生效（段内自带门控：未连接 codelphi MCP 或仓库匹配不到时自动跳过，不影响未接入的项目）：</p>
        <CopyBlock label="用户级常驻指令段（贴进 ~/.zcode/AGENTS.md 或 ~/.claude/CLAUDE.md）" text={WORKFLOW_AGENTS_SNIPPET} />
        <p>团队想把规范共享给所有成员时，可再把同段贴进仓库根目录 <code>AGENTS.md</code>（可选加强，非必需）。已连接本服务的 agent 还会随连接收到一份相同的约定（MCP instructions），即使用户级文件未配置也有基本触发。</p>
      </section>

      <p><Link href="/settings" className="text-button">去设置页签发 key →</Link></p>
      {!user ? <p><Link href="/" className="text-button">← 返回产品总览</Link></p> : null}
    </>
  );
  if (!user) return <PublicShell activeHref="/mcp">{page}</PublicShell>;
  return <AppShell user={user} activeHref="/mcp">{page}</AppShell>;
}
