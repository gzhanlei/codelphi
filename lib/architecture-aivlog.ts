import { architectureDocumentSchema, architectureDraftInputSchema, evidenceSources, type ArchitectureDocument, type ArchitectureDraftInput, type EvidenceCandidate } from "./architecture-draft";
import { getCodeHostingAdapter } from "./code-hosting/registry";

type AIVlogComponentId = "users" | "miniprogram" | "go-api" | "mysql" | "wechat" | "xpay" | "chandler" | "seedance" | "worker" | "aiphoto" | "remoteagent" | "cos";
type Component = ArchitectureDocument["components"][number];
type Connection = ArchitectureDocument["connections"][number];

const evidence: Record<Exclude<AIVlogComponentId, "users">, EvidenceCandidate[]> = {
  miniprogram: [
    { path: "miniprogram/utils/cloud.js", markers: ["wx.cloud.callContainer"] },
    { path: "miniprogram/utils/upload.js", markers: ["presign", "PUT"] },
    { path: "miniprogram/utils/virtualPay.js", markers: ["requestVirtualPayment"] },
  ],
  "go-api": [
    { path: "backend/cmd/server/main.go", markers: ["api.NewHandler", "store.Open"] },
    { path: "backend/internal/api/handlers.go", markers: ["r.Post(\"/api/productions\"", "session.Mint", "mountWorkerAPI"] },
    { path: "backend/internal/api/agent_wake.go", markers: ["wakeRenderAgent", "AgentWakeURL"] },
  ],
  mysql: [{ path: "backend/internal/store/mysql.go", markers: ["sql.Open(\"mysql\"", "productions"] }],
  wechat: [{ path: "backend/internal/wechatmp/client.go", markers: ["Code2Session", "ImgSecCheck"] }],
  xpay: [{ path: "backend/internal/xpay/xpay.go", markers: ["BuildPayment", "xpay_goods_deliver_notify", "xpay_refund_notify"] }],
  chandler: [
    { path: "backend/internal/api/admin_auth.go", markers: ["chandlerOAuthClient", "/v1/oauth/token"] },
    { path: "backend/internal/chandler/client.go", markers: ["Whoami", "legacy"] },
  ],
  seedance: [{ path: "backend/internal/seedance/client.go", markers: ["CreateTask", "/contents/generations/tasks", "DefaultBaseURL"] }],
  worker: [
    { path: "backend/cmd/worker/main.go", markers: ["worker.NewRunner", "SetImageStorer", "SetAssetPurger", "SetAutoRefunder"] },
    { path: "backend/internal/worker/runner.go", markers: ["aiphoto.Generate", "processRender", "renderOffload"] },
  ],
  aiphoto: [{ path: "backend/internal/aiphoto/client_v2.go", markers: ["/api/partner/v1/generate", "Generate"] }],
  remoteagent: [
    { path: "backend/cmd/remoteagent/main.go", markers: ["/api/worker/render-tasks/claim", "NewFFmpegClient", "complete"] },
    { path: "backend/internal/render/ffmpeg.go", markers: ["NewFFmpegClient", "cmd.Run", "PutObject"] },
  ],
  cos: [{ path: "backend/internal/cos/cos.go", markers: ["NewQCloudClient", "PresignPut", "PresignGet"] }],
};

const presentation: Record<AIVlogComponentId, Omit<Component, "id" | "sources">> = {
  users: { type: "external", label: "小程序用户", sublabel: "自拍 / 预览 / 支付 / 保存", pos: [30, 280], size: [130, 64] },
  miniprogram: { type: "frontend", label: "微信小程序", sublabel: "上传 / 进度 / 结果 / 虚拟支付", pos: [240, 280], size: [170, 64] },
  "go-api": { type: "backend", label: "Go API + 管理后台", sublabel: "云托管 / HMAC 会话 / RBAC", pos: [600, 280], size: [180, 64] },
  mysql: { type: "database", label: "云托管 MySQL", sublabel: "制作单 / 模板 / 身份 / 支付", pos: [1000, 280], size: [170, 64] },
  wechat: { type: "external", label: "微信小程序平台", sublabel: "code2session / imgSecCheck", pos: [240, 60], size: [170, 64] },
  xpay: { type: "external", label: "微信虚拟支付", sublabel: "米大师 / 发货与退款推送", pos: [800, 60], size: [170, 64] },
  chandler: { type: "security", label: "Chandler", sublabel: "管理后台 SSO / 旧身份迁移", pos: [600, 60], size: [180, 64] },
  seedance: { type: "external", label: "火山引擎 Seedance", sublabel: "管理后台底板视频", pos: [1000, 60], size: [170, 64] },
  worker: { type: "backend", label: "编排 Worker", sublabel: "生图 / 状态机 / 退款 / 清理", pos: [760, 540], size: [180, 64] },
  aiphoto: { type: "external", label: "AI-Photo", sublabel: "Partner 生图 / 轮询", pos: [1000, 540], size: [170, 64] },
  remoteagent: { type: "backend", label: "远程渲染 Agent", sublabel: "认领 / ffmpeg / 上报", pos: [540, 540], size: [190, 64] },
  cos: { type: "cloud", label: "腾讯云 COS", sublabel: "自拍 / 写真 / 底板 / 成片", pos: [240, 760], size: [180, 64] },
};

const connectionDefinitions: Connection[] = [
  { id: "users-to-miniprogram", from: "users", to: "miniprogram", label: "上传自拍 / 预览 / 支付", variant: "emphasis" },
  { id: "miniprogram-to-api", from: "miniprogram", to: "go-api", label: "wx.cloud.callContainer / Bearer" },
  { id: "miniprogram-to-cos", from: "miniprogram", to: "cos", label: "自拍 PUT / 成片 GET" },
  { id: "miniprogram-to-xpay", from: "miniprogram", to: "xpay", label: "requestVirtualPayment" },
  { id: "xpay-to-api", from: "xpay", to: "go-api", label: "发货 / 退款推送", variant: "dashed" },
  { id: "api-to-wechat", from: "go-api", to: "wechat", label: "code2session / 内容审核", variant: "security" },
  { id: "api-to-chandler", from: "go-api", to: "chandler", label: "管理 SSO / legacy Whoami", variant: "security" },
  { id: "api-to-seedance", from: "go-api", to: "seedance", label: "底板视频任务", variant: "dashed" },
  { id: "api-to-mysql", from: "go-api", to: "mysql", label: "制作单 / 模板 / 支付" },
  { id: "api-to-cos", from: "go-api", to: "cos", label: "预签名 GET / PUT" },
  { id: "worker-to-mysql", from: "worker", to: "mysql", label: "认领 / 状态机 / 清理" },
  { id: "worker-to-aiphoto", from: "worker", to: "aiphoto", label: "模板 + 自拍生图" },
  { id: "worker-to-cos", from: "worker", to: "cos", label: "写真 / 水印预览转存" },
  { id: "worker-to-xpay", from: "worker", to: "xpay", label: "失败单自动退款（配置时）", variant: "dashed" },
  { id: "worker-to-wechat", from: "worker", to: "wechat", label: "退款访问令牌（配置时）", variant: "dashed" },
  { id: "remoteagent-to-api", from: "remoteagent", to: "go-api", label: "claim / complete / fail" },
  { id: "api-to-remoteagent", from: "go-api", to: "remoteagent", label: "唤醒 + 预签名任务", variant: "dashed" },
  { id: "remoteagent-to-cos", from: "remoteagent", to: "cos", label: "素材 GET / 成片 PUT" },
];

const componentOrder = Object.keys(presentation) as AIVlogComponentId[];
const requiredComponents = componentOrder.filter((id) => id !== "users");

export const aivlogArchitectureEvidencePaths = [...new Set(Object.values(evidence).flatMap((candidates) => candidates.map((candidate) => candidate.path)))].sort();

export function isAIVlogRepository(input: { owner: string; name: string }) {
  return input.owner.toLowerCase() === "gzhanlei" && input.name.toLowerCase() === "aivlog";
}

export function buildAIVlogArchitectureDocument(value: ArchitectureDraftInput): ArchitectureDocument {
  const input = architectureDraftInputSchema.parse(value);
  if (!isAIVlogRepository(input)) throw new Error("Deterministic architecture template is only available for gzhanlei/AIVlog");
  const sources = [...input.sources].sort((a, b) => a.path.localeCompare(b.path));
  const missing = requiredComponents.filter((id) => evidenceSources(evidence[id], sources).length !== evidence[id].length);
  if (missing.length > 0) throw new Error(`Architecture evidence incomplete: ${missing.join(", ")}`);
  const components = componentOrder.map((id) => ({ id, ...presentation[id], sources: id === "users" ? undefined : evidenceSources(evidence[id], sources) }));
  return architectureDocumentSchema.parse({
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: `${input.productName} 系统架构`,
      output: `${input.productSlug}-architecture.html`,
      locale: "zh-CN",
      quality_profile: "showcase",
      repository: { url: getCodeHostingAdapter(input.provider).repositoryUrl(input), provider: input.provider, revision: input.revision },
      viewBox: [1200, 880],
    },
    components,
    connections: connectionDefinitions,
  });
}
