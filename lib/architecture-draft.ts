import { z } from "zod";
import { codeHostingProviderSchema } from "./code-hosting/types";
import { getCodeHostingAdapter } from "./code-hosting/registry";

export const architectureDraftInputSchema = z.object({
  productName: z.string().min(1),
  productSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  owner: z.string().min(1),
  provider: codeHostingProviderSchema.default("github"),
  name: z.string().min(1),
  revision: z.string().regex(/^[a-fA-F0-9]{40}$/),
  sources: z.array(z.object({ path: z.string(), content: z.string() })),
});

export type ArchitectureDraftInput = z.input<typeof architectureDraftInputSchema>;

const sourceSchema = z.object({ path: z.string(), line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional(), label: z.string().optional() });
const componentSchema = z.object({
  id: z.string(),
  type: z.enum(["frontend", "backend", "database", "cloud", "security", "messagebus", "external"]),
  label: z.string(),
  sublabel: z.string().optional(),
  tag: z.string().optional(),
  sources: z.array(sourceSchema).max(3).optional(),
  pos: z.tuple([z.number(), z.number()]),
  size: z.tuple([z.number(), z.number()]),
});
const connectionSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  variant: z.enum(["default", "emphasis", "security", "dashed"]).optional(),
  fromSide: z.enum(["left", "right", "top", "bottom"]).optional(),
  toSide: z.enum(["left", "right", "top", "bottom"]).optional(),
  labelDy: z.number().optional(),
});

export const architectureDocumentSchema = z.object({
  schema_version: z.literal(1),
  diagram_type: z.literal("architecture"),
  meta: z.object({
    title: z.string(),
    output: z.string(),
    locale: z.literal("zh-CN"),
    quality_profile: z.literal("showcase"),
    repository: z.object({ url: z.string().url(), provider: codeHostingProviderSchema, revision: z.string() }),
    viewBox: z.tuple([z.number(), z.number()]),
  }),
  components: z.array(componentSchema).min(2),
  connections: z.array(connectionSchema),
});

export type ArchitectureDocument = z.infer<typeof architectureDocumentSchema>;
type Component = ArchitectureDocument["components"][number];
type Connection = ArchitectureDocument["connections"][number];
type ComponentId = "users" | "radar-ui" | "chandler" | "next-api" | "tenancy" | "mysql" | "webhook" | "analysis" | "source-index" | "github" | "llm" | "archify";

interface EvidenceCandidate {
  path: string;
  markers: string[];
}

const evidence: Record<Exclude<ComponentId, "users">, EvidenceCandidate[]> = {
  "radar-ui": [
    { path: "app/products/[slug]/page.tsx", markers: ["getProductDetails", "ProductView"] },
    { path: "components/product-navigation.tsx", markers: ["ProductView", "ProductTabs"] },
  ],
  chandler: [
    { path: "lib/chandler.ts", markers: ["WorkMembership", "OAuth", "chandler"] },
    { path: "app/auth/callback/route.ts", markers: ["completeChandlerOAuth", "oauth"] },
  ],
  "next-api": [
    { path: "app/api/products/route.ts", markers: ["registerProduct", "POST"] },
    { path: "app/products/[slug]/page.tsx", markers: ["getProductDetails", "ProductView"] },
  ],
  tenancy: [
    { path: "lib/organizations.ts", markers: ["requireOrganization", "organization_members", "role"] },
    { path: "migrations/008_multi_tenant.sql", markers: ["organization_members", "CREATE TABLE"] },
  ],
  mysql: [
    { path: "lib/db.ts", markers: ["mysql2", "databaseConfig"] },
    { path: "migrations/002_spec_versions.sql", markers: ["spec_versions", "CREATE TABLE"] },
  ],
  webhook: [
    { path: "app/api/webhooks/github/route.ts", markers: ["processGitHubWebhook", "POST"] },
    { path: "lib/github-webhook.ts", markers: ["verifyGitHubSignature", "push"] },
  ],
  analysis: [
    { path: "lib/analysis.ts", markers: ["analyzeWithAI", "insertSpecVersion"] },
    { path: "lib/spec-versions.ts", markers: ["insertSpecVersion", "spec_versions"] },
  ],
  "source-index": [
    { path: "lib/remote-source-index/index.ts", markers: ["RemoteSourceRevision", "readLines", "fetchVerifiedBlob"] },
    { path: "lib/remote-analysis.ts", markers: ["getRemoteAnalysisSources", "sliceToSourceFiles"] },
  ],
  github: [
    { path: "lib/github.ts", markers: ["api.github.com", "resolveGitHubToken"] },
    { path: "lib/github-app.ts", markers: ["installation", "createAppJwt"] },
  ],
  llm: [{ path: "lib/ai.ts", markers: ["chatCompletionsUrl", "AI_API_KEY", "LLMGateway"] }],
  archify: [
    { path: "lib/architecture-version.ts", markers: ["generateArchitectureVersion", "visualCheck"] },
    { path: "lib/archify-cli.ts", markers: ["deliverArchify", "visualCheckArchify"] },
  ],
};

const presentation: Record<ComponentId, Omit<Component, "id" | "sources">> = {
  users: { type: "external", label: "内部用户", sublabel: "产品 / 研发 / 测试", pos: [30, 300], size: [130, 64] },
  "radar-ui": { type: "frontend", label: "Radar Web UI", sublabel: "产品规格与发布变化", pos: [260, 300], size: [150, 64] },
  chandler: { type: "security", label: "Chandler", sublabel: "WorkMembership OAuth", pos: [260, 60], size: [150, 64] },
  "next-api": { type: "backend", label: "Next.js Server", sublabel: "Server Components / API", pos: [530, 300], size: [150, 64] },
  tenancy: { type: "security", label: "Workspace / RBAC", sublabel: "组织成员与编辑权限", pos: [530, 60], size: [160, 64] },
  mysql: { type: "database", label: "MySQL", sublabel: "多租户规格、发布与 Diff", pos: [1050, 300], size: [150, 64] },
  webhook: { type: "backend", label: "GitHub Webhook", sublabel: "HMAC-SHA256 / push", pos: [260, 540], size: [150, 64] },
  analysis: { type: "backend", label: "分析任务", sublabel: "after() / 规格与发布", pos: [700, 540], size: [150, 64] },
  "source-index": { type: "backend", label: "远程源码索引", sublabel: "固定 SHA / Tree + Blob", pos: [700, 760], size: [170, 64] },
  github: { type: "external", label: "GitHub", sublabel: "App / 仓库 / Installation Token", pos: [420, 760], size: [160, 64] },
  llm: { type: "external", label: "LLMGateway", sublabel: "结构化产品分析", pos: [1050, 540], size: [150, 64] },
  archify: { type: "backend", label: "Archify", sublabel: "证据校验 / HTML 验收", pos: [850, 60], size: [160, 64] },
};

const connectionDefinitions: Connection[] = [
  { id: "users-to-radar", from: "users", to: "radar-ui", label: "HTTPS", variant: "emphasis" },
  { id: "oauth-login", from: "radar-ui", to: "chandler", label: "OAuth 2.0 + PKCE", variant: "security", fromSide: "top", toSide: "bottom" },
  { id: "ui-to-server", from: "radar-ui", to: "next-api", label: "页面 / API" },
  { id: "server-to-tenancy", from: "next-api", to: "tenancy", label: "session / workspace", variant: "security", fromSide: "top", toSide: "bottom" },
  { id: "tenancy-to-mysql", from: "tenancy", to: "mysql", label: "membership / RBAC", variant: "security" },
  { id: "server-to-mysql", from: "next-api", to: "mysql", label: "SQL" },
  { id: "server-to-analysis", from: "next-api", to: "analysis", label: "after() 手动分析", variant: "dashed", fromSide: "bottom", toSide: "top" },
  { id: "github-to-webhook", from: "github", to: "webhook", label: "push 事件", fromSide: "left", toSide: "bottom" },
  { id: "webhook-to-analysis", from: "webhook", to: "analysis", label: "创建分析任务", variant: "dashed" },
  { id: "analysis-to-source-index", from: "analysis", to: "source-index", label: "固定 revision", fromSide: "bottom", toSide: "top" },
  { id: "source-index-to-github", from: "source-index", to: "github", label: "tree / blob API", fromSide: "left", toSide: "right" },
  { id: "analysis-to-github", from: "analysis", to: "github", label: "contents:read", fromSide: "bottom", toSide: "top" },
  { id: "analysis-to-llm", from: "analysis", to: "llm", label: "代码 + diff" },
  { id: "analysis-to-mysql", from: "analysis", to: "mysql", label: "不可变规格版本", fromSide: "right", toSide: "bottom" },
  { id: "analysis-to-archify", from: "analysis", to: "archify", label: "规格 + 证据", fromSide: "top", toSide: "bottom" },
  { id: "archify-to-mysql", from: "archify", to: "mysql", label: "架构版本", fromSide: "right", toSide: "top" },
];

const componentOrder: ComponentId[] = ["users", "radar-ui", "chandler", "next-api", "tenancy", "mysql", "webhook", "analysis", "source-index", "github", "llm", "archify"];
const requiredComponents = componentOrder.filter((id) => id !== "users");

export const radarArchitectureEvidencePaths = [...new Set(Object.values(evidence).flatMap((candidates) => candidates.map((candidate) => candidate.path)))].sort();

export function markerLine(content: string, markers: string[]) {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => markers.some((marker) => line.toLowerCase().includes(marker.toLowerCase())));
  return index < 0 ? undefined : index + 1;
}

function componentSources(id: ComponentId, sources: ArchitectureDraftInput["sources"]) {
  if (id === "users") return undefined;
  const matches = evidence[id].flatMap((candidate) => {
    const source = sources.find((item) => item.path === candidate.path);
    if (!source) return [];
    const line = markerLine(source.content, candidate.markers);
    return line === undefined ? [] : [{ path: candidate.path, line }];
  });
  return matches.length > 0 ? matches : undefined;
}

function createComponent(id: ComponentId, sources: ArchitectureDraftInput["sources"]): Component {
  return { id, ...presentation[id], sources: componentSources(id, sources) };
}

export function buildArchitectureDocument(value: ArchitectureDraftInput): ArchitectureDocument {
  const input = architectureDraftInputSchema.parse(value);
  if (input.owner !== "gzhanlei" || input.name !== "radar") throw new Error("Deterministic architecture template is only available for gzhanlei/radar");
  const sources = [...input.sources].sort((a, b) => a.path.localeCompare(b.path));
  const missing = requiredComponents.filter((id) => !componentSources(id, sources));
  if (missing.length > 0) throw new Error(`Architecture evidence incomplete: ${missing.join(", ")}`);
  const components = componentOrder.map((id) => createComponent(id, sources));
  const connections = connectionDefinitions;
  return architectureDocumentSchema.parse({
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: `${input.productName} 系统架构`,
      output: `${input.productSlug}-architecture.html`,
      locale: "zh-CN",
      quality_profile: "showcase",
      repository: { url: getCodeHostingAdapter(input.provider).repositoryUrl(input), provider: input.provider, revision: input.revision },
      viewBox: [1240, 880],
    },
    components,
    connections,
  });
}
