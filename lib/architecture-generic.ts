import { architectureDocumentSchema, architectureDraftInputSchema, markerLine, buildArchitectureDocument as buildRadarArchitectureDocument, type ArchitectureDocument, type ArchitectureDraftInput } from "./architecture-draft";

type GenericId = "frontend" | "backend" | "auth" | "db" | "github" | "llm" | "webhook" | "analysis";
type Component = ArchitectureDocument["components"][number];
type Connection = ArchitectureDocument["connections"][number];

interface EvidenceRule {
  path: RegExp;
  markers: string[];
}

const rules: Record<GenericId, EvidenceRule> = {
  frontend: { path: /(?:^|\/)app\/.*page\.tsx$/, markers: ["export default", "export function"] },
  backend: { path: /(?:^|\/)(?:internal\/.*\.go|app\/api\/.*route\.ts)$/, markers: ["func ", "POST", "GET"] },
  auth: { path: /oauth|auth|chandler/i, markers: ["OAuth", "WorkMembership", "PKCE"] },
  db: { path: /./, markers: ["go-sql-driver/mysql", "mysql2", "sql.Open", "database/sql"] },
  github: { path: /github/i, markers: ["api.github.com", "Installation"] },
  llm: { path: /ai|llm|gateway/i, markers: ["chat/completions", "OpenAI", "LLMGateway", "AI_API_KEY"] },
  webhook: { path: /webhook/i, markers: ["webhook", "push"] },
  analysis: { path: /analysis|spec/i, markers: ["analyzeWithAI", "insertSpecVersion", "SpecVersion"] },
};

const presentation: Record<GenericId | "users", Omit<Component, "id" | "sources">> = {
  users: { type: "external", label: "内部用户", sublabel: "产品 / 研发 / 测试", pos: [20, 60], size: [130, 64] },
  frontend: { type: "frontend", label: "产品 Web UI", sublabel: "Next.js App Router", pos: [220, 60], size: [150, 64] },
  backend: { type: "backend", label: "应用服务", sublabel: "Go / Next.js API", pos: [220, 220], size: [150, 64] },
  auth: { type: "security", label: "身份与 OAuth", sublabel: "OAuth 2.0 / PKCE", pos: [420, 60], size: [150, 64] },
  db: { type: "database", label: "MySQL", sublabel: "持久化数据", pos: [220, 360], size: [130, 64] },
  webhook: { type: "backend", label: "GitHub Webhook", sublabel: "HMAC-SHA256 / push", pos: [20, 360], size: [150, 64] },
  analysis: { type: "backend", label: "分析任务", sublabel: "代码证据 / Spec Version", pos: [420, 220], size: [150, 64] },
  github: { type: "external", label: "GitHub", sublabel: "仓库与安装凭据", pos: [420, 300], size: [150, 64] },
  llm: { type: "external", label: "LLM 网关", sublabel: "结构化产品分析", pos: [620, 220], size: [130, 64] },
};

const connectionDefinitions: Connection[] = [
  { id: "users-to-frontend", from: "users", to: "frontend", label: "HTTPS", variant: "emphasis" },
  { id: "frontend-to-backend", from: "frontend", to: "backend", label: "页面 / API" },
  { id: "frontend-to-auth", from: "frontend", to: "auth", label: "OAuth 2.0 + PKCE", variant: "security", fromSide: "top", toSide: "bottom" },
  { id: "backend-to-db", from: "backend", to: "db", label: "SQL" },
  { id: "backend-to-analysis", from: "backend", to: "analysis", label: "after() 分析", variant: "dashed", fromSide: "bottom", toSide: "top" },
  { id: "github-to-webhook", from: "github", to: "webhook", label: "push 事件", fromSide: "left", toSide: "bottom" },
  { id: "webhook-to-analysis", from: "webhook", to: "analysis", label: "创建分析任务", variant: "dashed" },
  { id: "analysis-to-github", from: "analysis", to: "github", label: "contents:read", fromSide: "bottom", toSide: "top", labelDy: 24 },
  { id: "analysis-to-llm", from: "analysis", to: "llm", label: "代码 + diff" },
  { id: "analysis-to-db", from: "analysis", to: "db", label: "规格版本", fromSide: "top", toSide: "bottom" },
];

const componentOrder: Array<GenericId | "users"> = ["users", "frontend", "backend", "auth", "db", "webhook", "analysis", "github", "llm"];

function sourcesFor(id: GenericId, sources: ArchitectureDraftInput["sources"]) {
  const rule = rules[id];
  const matches = sources.flatMap((source) => {
    if (!rule.path.test(source.path)) return [];
    const line = markerLine(source.content, rule.markers);
    return line === undefined ? [] : [{ path: source.path, line }];
  });
  return matches.slice(0, 3);
}

function createComponent(id: GenericId | "users", sources: ArchitectureDraftInput["sources"]): Component {
  const evidence = id === "users" ? undefined : sourcesFor(id, sources);
  return { id, ...presentation[id], sources: evidence };
}

export function buildArchitectureDocument(value: ArchitectureDraftInput): ArchitectureDocument {
  const input = architectureDraftInputSchema.parse(value);
  if (input.owner === "gzhanlei" && input.name === "radar") return buildRadarArchitectureDocument(value);
  const sources = [...input.sources].sort((a, b) => a.path.localeCompare(b.path));
  const components = componentOrder.filter((id) => id === "users" || sourcesFor(id, sources).length > 0).map((id) => createComponent(id, sources));
  if (components.length < 2) throw new Error("No architecture components detected");
  const ids = new Set(components.map((component) => component.id));
  const viewBoxHeight = Math.max(240, Math.max(...components.map((component) => component.pos[1])) + 96);
  const viewBoxWidth = Math.max(500, Math.max(...components.map((component) => component.pos[0] + component.size[0])) + 180);
  const connections = connectionDefinitions.filter((connection) => ids.has(connection.from as GenericId) && ids.has(connection.to as GenericId));
  return architectureDocumentSchema.parse({
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: `${input.productName} 系统架构`,
      output: `${input.productSlug}-architecture.html`,
      locale: "zh-CN",
      quality_profile: "showcase",
      repository: { url: `https://github.com/${input.owner}/${input.name}`, provider: "github", revision: input.revision },
      viewBox: [viewBoxWidth, viewBoxHeight],
    },
    components,
    connections,
  });
}
