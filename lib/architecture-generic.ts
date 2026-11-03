import { architectureDocumentSchema, architectureDraftInputSchema, markerLine, buildArchitectureDocument as buildRadarArchitectureDocument, type ArchitectureDocument, type ArchitectureDraftInput } from "./architecture-draft";

type GenericId = "frontend" | "backend" | "auth" | "db" | "github" | "llm" | "webhook" | "analysis" | "android-ui" | "android-data" | "android-local-db" | "android-network" | "android-service" | "native-bridge" | "native-core" | "media-sink";
type Component = ArchitectureDocument["components"][number];
type Connection = ArchitectureDocument["connections"][number];

interface EvidenceRule {
  path: RegExp;
  markers: string[];
}

const rules: Record<GenericId, EvidenceRule> = {
  frontend: { path: /(?:^|\/)app\/.*page\.tsx$|(?:^|\/)src\/(?:App|main)\.tsx$|(?:^|\/)pages\/(?:index|_app)\.tsx$|(?:^|\/)resources\/js\/.*\.tsx$/, markers: ["export default", "export function", "createRoot", "ReactDOM"] },
  backend: { path: /(?:^|\/)internal\/.*\.go$|(?:^|\/)app\/api\/.*route\.ts$|(?:^|\/)src\/main\/(?:java|kotlin)\/.*\.(?:java|kt)$|(?:^|\/)app\/.*\.py$|(?:^|\/)src\/.*\.rs$|(?:^|\/)app\/.*\.php$|(?:^|\/)src\/.*\.cs$|(?:^|\/)cmd\/.*\.go$/, markers: ["@SpringBootApplication", "@RestController", "class Controller", "APIRouter", "FastAPI", "func ", "Router::new", "Route::", "class Program", "namespace", "POST", "GET"] },
  auth: { path: /oauth|auth|chandler/i, markers: ["OAuth", "WorkMembership", "PKCE", "Spring Security", "JWT", "passport", "Authorize"] },
  db: { path: /./, markers: ["go-sql-driver/mysql", "mysql2", "sql.Open", "database/sql", "spring.datasource", "JpaRepository", "SQLAlchemy", "SQLModel", "sqlmodel", "EntityFrameworkCore", "gorm.Open", "DB::", "CREATE TABLE", "RoomDatabase"] },
  github: { path: /github/i, markers: ["api.github.com", "Installation"] },
  llm: { path: /ai|llm|gateway/i, markers: ["chat/completions", "OpenAI", "LLMGateway", "AI_API_KEY"] },
  webhook: { path: /webhook/i, markers: ["webhook", "push"] },
  analysis: { path: /analysis|spec/i, markers: ["analyzeWithAI", "insertSpecVersion", "SpecVersion"] },
  "android-ui": { path: /(?:^|\/)app\/src\/main\/(?:java|kotlin)\/.*(?:Activity\.java|Activity\.kt)$/, markers: ["extends Activity", "ComponentActivity", "AppCompatActivity", "setContent", "SurfaceView", "setContentView"] },
  "android-data": { path: /(?:^|\/)core\/data\/.*\.kt$|(?:^|\/)data\/repository\/.*\.kt$/, markers: ["Repository", "DataSource", "Dao"] },
  "android-local-db": { path: /(?:^|\/)core\/database\/.*\.kt$/, markers: ["@Database", "RoomDatabase", "NiaDatabase", "Dao"] },
  "android-network": { path: /(?:^|\/)core\/network\/.*\.kt$/, markers: ["NiaNetworkDataSource", "Retrofit", "HttpClient", "Ktor"] },
  "android-service": { path: /(?:^|\/)app\/src\/main\/(?:java|kotlin)\/.*(?:Service\.java|Service\.kt)$/, markers: ["extends Service", "NsdManager", "onStartCommand"] },
  "native-bridge": { path: /(?:^|\/)app\/src\/main\/(?:java\/.*NativeBridge\.java|cpp\/.*\.c)$/, markers: ["System.loadLibrary", "JNI_OnLoad", "Java_com_", "C ↔ Java"] },
  "native-core": { path: /(?:^|\/)lib\/.*\.c$/, markers: ["raop_init", "httpd_start", "conn_request", "conn_init"] },
  "media-sink": { path: /(?:^|\/)app\/src\/main\/java\/.*(?:Video|Audio)Sink\.java$/, markers: ["MediaCodec", "AudioTrack", "Surface"] },
};

const presentation: Record<GenericId | "users", Omit<Component, "id" | "sources">> = {
  users: { type: "external", label: "内部用户", sublabel: "产品 / 研发 / 测试", pos: [40, 280], size: [130, 64] },
  frontend: { type: "frontend", label: "产品 Web UI", sublabel: "Next.js App Router", pos: [340, 280], size: [150, 64] },
  backend: { type: "backend", label: "应用服务", sublabel: "Go / Next.js API", pos: [640, 280], size: [150, 64] },
  auth: { type: "security", label: "身份与 OAuth", sublabel: "OAuth 2.0 / PKCE", pos: [340, 70], size: [150, 64] },
  db: { type: "database", label: "MySQL", sublabel: "持久化数据", pos: [940, 280], size: [130, 64] },
  webhook: { type: "backend", label: "GitHub Webhook", sublabel: "HMAC-SHA256 / push", pos: [340, 490], size: [150, 64] },
  analysis: { type: "backend", label: "分析任务", sublabel: "代码证据 / Spec Version", pos: [640, 490], size: [150, 64] },
  github: { type: "external", label: "GitHub", sublabel: "仓库与安装凭据", pos: [640, 600], size: [150, 64] },
  llm: { type: "external", label: "LLM 网关", sublabel: "结构化产品分析", pos: [940, 490], size: [130, 64] },
  "android-ui": { type: "frontend", label: "Android UI", sublabel: "Activity / SurfaceView", pos: [340, 280], size: [150, 64] },
  "android-data": { type: "backend", label: "数据与仓储层", sublabel: "Repository / DataSource", pos: [640, 490], size: [150, 64] },
  "android-local-db": { type: "database", label: "本地数据存储", sublabel: "Room / SQLite", pos: [940, 280], size: [130, 64] },
  "android-network": { type: "backend", label: "网络数据同步", sublabel: "Remote DataSource", pos: [940, 490], size: [150, 64] },
  "android-service": { type: "backend", label: "Android 服务", sublabel: "Foreground Service / NSD", pos: [640, 280], size: [150, 64] },
  "native-bridge": { type: "messagebus", label: "JNI 桥", sublabel: "Java ↔ Native 回调", pos: [940, 490], size: [150, 64] },
  "native-core": { type: "backend", label: "原生协议核心", sublabel: "C / RAOP / HTTPD", pos: [640, 490], size: [150, 64] },
  "media-sink": { type: "backend", label: "媒体输出", sublabel: "MediaCodec / AudioTrack", pos: [340, 490], size: [150, 64] },
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
  { id: "users-to-android-ui", from: "users", to: "android-ui", label: "打开界面", variant: "emphasis" },
  { id: "android-ui-to-data", from: "android-ui", to: "android-data", label: "状态 / 请求" },
  { id: "android-data-to-local-db", from: "android-data", to: "android-local-db", label: "Room 读写" },
  { id: "android-data-to-network", from: "android-data", to: "android-network", label: "远程同步" },
  { id: "android-network-to-data", from: "android-network", to: "android-data", label: "数据刷新", variant: "dashed" },
  { id: "android-ui-to-service", from: "android-ui", to: "android-service", label: "启动 / Surface" },
  { id: "android-service-to-bridge", from: "android-service", to: "native-bridge", label: "nativeStart / 回调", fromSide: "bottom", toSide: "top" },
  { id: "native-bridge-to-core", from: "native-bridge", to: "native-core", label: "raop_init" },
  { id: "native-core-to-bridge", from: "native-core", to: "native-bridge", label: "视频 / 音频回调", variant: "dashed", fromSide: "top", toSide: "bottom" },
  { id: "native-core-to-sink", from: "native-core", to: "media-sink", label: "NALU / AAC" },
  { id: "media-sink-to-android-ui", from: "media-sink", to: "android-ui", label: "Surface / AudioTrack", fromSide: "top", toSide: "bottom" },
];

const componentOrder: Array<GenericId | "users"> = ["users", "frontend", "backend", "auth", "db", "webhook", "analysis", "github", "llm", "android-ui", "android-data", "android-local-db", "android-network", "android-service", "native-bridge", "native-core", "media-sink"];

function sourcesFor(id: GenericId, sources: ArchitectureDraftInput["sources"]) {
  const rule = rules[id];
  const matches = sources.flatMap((source) => {
    if (id === "db" && source.path.includes("core/database/")) return [];
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
  const viewBoxWidth = Math.min(1200, Math.max(960, Math.max(...components.map((component) => component.pos[0] + component.size[0])) + 180));
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
