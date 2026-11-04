import { describe, expect, it } from "vitest";
import { aivlogArchitectureEvidencePaths, buildAIVlogArchitectureDocument } from "../lib/architecture-aivlog";
import { buildArchitectureDocument } from "../lib/architecture-generic";

const revision = "13157624fb0d8b63e5072049c94824d4b6d2e609";
const markers = "wx.cloud.callContainer presign PUT requestVirtualPayment api.NewHandler store.Open worker.NewRunner SetImageStorer SetAssetPurger SetAutoRefunder wakeRenderAgent AgentWakeURL /api/worker/render-tasks/claim NewFFmpegClient complete r.Post(\"/api/productions\" session.Mint mountWorkerAPI chandlerOAuthClient /v1/oauth/token Whoami aiphoto.Generate processRender renderOffload sql.Open(\"mysql\" productions NewQCloudClient PresignPut PresignGet /api/partner/v1/generate Generate cmd.Run PutObject Code2Session ImgSecCheck BuildPayment xpay_goods_deliver_notify xpay_refund_notify CreateTask /contents/generations/tasks DefaultBaseURL";

function sources(paths = aivlogArchitectureEvidencePaths) {
  return paths.map((path) => ({ path, content: `1: ${path} ${markers}` }));
}

function input(overrides: { owner?: string; name?: string; sources?: ReturnType<typeof sources> } = {}) {
  return { productName: "AI视频小程序", productSlug: "aivlog", owner: overrides.owner ?? "gzhanlei", name: overrides.name ?? "AIVlog", revision, sources: overrides.sources ?? sources().reverse() };
}

describe("AIVlog architecture", () => {
  it("describes the actual mini-program, AI generation, payment and remote rendering system", () => {
    const document = buildAIVlogArchitectureDocument(input());
    expect(document.components.map((component) => component.id)).toEqual(["users", "miniprogram", "go-api", "mysql", "wechat", "xpay", "chandler", "seedance", "worker", "aiphoto", "remoteagent", "cos"]);
    expect(document.components.map((component) => component.id)).not.toContain("frontend");
    expect(document.components.flatMap((component) => component.sources ?? []).every((source) => source.line && source.line > 0)).toBe(true);
    expect(document.meta.viewBox).toEqual([1200, 880]);
    expect(document.connections).toHaveLength(18);
    expect(document.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "miniprogram", to: "go-api", label: "wx.cloud.callContainer / Bearer" }),
      expect.objectContaining({ from: "miniprogram", to: "cos", label: "自拍 PUT / 成片 GET" }),
      expect.objectContaining({ from: "worker", to: "mysql", label: "认领 / 状态机 / 清理" }),
      expect.objectContaining({ from: "worker", to: "aiphoto", label: "模板 + 自拍生图" }),
      expect.objectContaining({ from: "worker", to: "xpay", label: "失败单自动退款（配置时）" }),
      expect.objectContaining({ from: "worker", to: "wechat", label: "退款访问令牌（配置时）" }),
      expect.objectContaining({ from: "go-api", to: "cos", label: "预签名 GET / PUT" }),
      expect.objectContaining({ from: "remoteagent", to: "go-api", label: "claim / complete / fail" }),
      expect.objectContaining({ from: "remoteagent", to: "cos", label: "素材 GET / 成片 PUT" }),
      expect.objectContaining({ from: "xpay", to: "go-api", label: "发货 / 退款推送" }),
    ]));
    expect(document.connections).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "go-api", to: "worker" }),
      expect.objectContaining({ from: "worker", to: "remoteagent" }),
    ]));
    expect(JSON.stringify(document)).not.toContain("Next.js");
    expect(buildAIVlogArchitectureDocument(input())).toEqual(document);
  });

  it("uses the specialized template through the generic repository boundary", () => {
    expect(buildArchitectureDocument(input()).components).toHaveLength(12);
    expect(() => buildAIVlogArchitectureDocument(input({ owner: "other" }))).toThrow("only available for gzhanlei/AIVlog");
    expect(() => buildAIVlogArchitectureDocument(input({ name: "other" }))).toThrow("only available for gzhanlei/AIVlog");
  });

  it("fails closed when remote rendering or another required boundary loses evidence", () => {
    const missingRender = aivlogArchitectureEvidencePaths.filter((path) => path !== "backend/cmd/remoteagent/main.go" && path !== "backend/internal/render/ffmpeg.go");
    expect(() => buildAIVlogArchitectureDocument(input({ sources: sources(missingRender) }))).toThrow("Architecture evidence incomplete: remoteagent");
    expect(() => buildAIVlogArchitectureDocument(input({ sources: sources(aivlogArchitectureEvidencePaths.filter((path) => path !== "backend/internal/seedance/client.go")) }))).toThrow("Architecture evidence incomplete: seedance");
    expect(() => buildAIVlogArchitectureDocument(input({ sources: sources(aivlogArchitectureEvidencePaths.filter((path) => path !== "backend/internal/render/ffmpeg.go")) }))).toThrow("Architecture evidence incomplete: remoteagent");
  });
});
