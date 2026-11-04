import type { EdgeFact, NodeFact } from "../facts";
import { architectureRuntimeSources, findArchitectureEvidence, signalIdsForPaths, uniqueEvidence } from "../source";
import { emptyArchitectureFragment, factEdge, type ArchitectureContext, type ArchitectureDetector } from "./types";

interface ExternalRule {
  id: string;
  kind: NodeFact["kind"];
  label: string;
  path: RegExp;
  markers: string[];
  callers: string[];
  edgeKind: EdgeFact["kind"];
}

const rules: ExternalRule[] = [
  { id: "store:cos", kind: "object-store", label: "对象存储 COS", path: /cos|upload/i, markers: ["NewQCloudClient", "PresignPut", "PresignGet", "cos.tencentcloudapi.com"], callers: ["cos.", "/cos", "Presign", "upload_url", "UploadURL"], edgeKind: "upload" },
  { id: "external:wechat", kind: "external", label: "微信平台", path: /wechat|miniprogram/i, markers: ["Code2Session", "ImgSecCheck", "wechatmp.NewClient"], callers: ["wechatmp.", "/wechatmp", "Code2Session", "ImgSecCheck"], edgeKind: "http" },
  { id: "external:xpay", kind: "external", label: "虚拟支付", path: /xpay|virtualpay/i, markers: ["BuildPayment", "xpay_goods_deliver_notify", "xpay_refund_notify", "requestVirtualPayment"], callers: ["xpay.", "/xpay", "requestVirtualPayment"], edgeKind: "http" },
  { id: "external:aiphoto", kind: "external", label: "AI-Photo", path: /aiphoto/i, markers: ["/api/partner/v1/generate", "aiphoto.Generate", "aiphoto.New"], callers: ["aiphoto.", "/aiphoto"], edgeKind: "http" },
  { id: "external:seedance", kind: "external", label: "Seedance", path: /seedance/i, markers: ["/contents/generations/tasks", "seedance.CreateTask"], callers: ["seedance.", "/seedance"], edgeKind: "http" },
  { id: "external:chandler", kind: "external", label: "Chandler 身份平台", path: /chandler/i, markers: ["chandlerOAuthClient", "/v1/oauth/token", "Whoami"], callers: ["chandler.", "/chandler", "chandlerOAuthClient"], edgeKind: "oauth" },
  { id: "external:github", kind: "external", label: "GitHub", path: /github/i, markers: ["api.github.com"], callers: ["api.github.com", "github."], edgeKind: "http" },
  { id: "external:llm", kind: "external", label: "LLM 网关", path: /./, markers: ["chat/completions"], callers: ["chat/completions", "OpenAI"], edgeKind: "http" },
  { id: "external:archify", kind: "external", label: "Archify 渲染器", path: /archify/i, markers: ["deliverArchify", "visualCheckArchify"], callers: ["archify", "deliverArchify", "visualCheckArchify"], edgeKind: "process" },
];

function externalNode(context: ArchitectureContext, rule: ExternalRule): NodeFact | undefined {
  const sources = context.sources.filter((source) => rule.path.test(source.path));
  const evidence = uniqueEvidence(sources.flatMap((source) => {
    const match = findArchitectureEvidence(source, rule.markers, `${rule.id}-client`);
    return match ? [match] : [];
  }));
  if (evidence.length === 0) return undefined;
  return { id: rule.id, kind: rule.kind, label: rule.label, signalIds: signalIdsForPaths(context.signals, evidence.map((item) => item.path)), evidence };
}

function detectExternal(context: ArchitectureContext) {
  const fragment = emptyArchitectureFragment();
  for (const rule of rules) {
    const node = externalNode(context, rule);
    if (node) fragment.nodes.push(node);
  }
  return fragment;
}

export function linkExternalRelationships(context: ArchitectureContext, nodes: NodeFact[]) {
  const externalNodes = new Map(nodes.map((node) => [node.id, node]));
  const runtimes = nodes.filter((node) => ["frontend", "api", "worker", "agent"].includes(node.kind));
  return rules.filter((rule) => externalNodes.has(rule.id)).flatMap((rule) => runtimes.flatMap((runtime) => {
    if (runtime.id === rule.id) return [];
    const evidence = uniqueEvidence(architectureRuntimeSources(runtime, context.sources).flatMap((source) => {
      const match = findArchitectureEvidence(source, rule.callers, `${rule.id}-caller`);
      return match ? [match] : [];
    }));
    if (evidence.length === 0) return [];
    return [factEdge(`${rule.edgeKind}:${runtime.id}->${rule.id}`, runtime.id, rule.id, rule.edgeKind, rule.label, evidence, signalIdsForPaths(context.signals, evidence.map((item) => item.path)))];
  }));
}

const callbackRules = [
  { id: "external:xpay", path: /xpay/i, markers: ["xpay_goods_deliver_notify", "xpay_refund_notify"], label: "支付结果推送" },
  { id: "external:github", path: /webhook/i, markers: ["webhook", "push"], label: "GitHub Webhook" },
];

export function externalCallbackRelationships(context: ArchitectureContext, nodes: NodeFact[]) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return callbackRules.filter((rule) => nodeIds.has(rule.id)).flatMap((rule) => nodes.filter((node) => node.kind === "api").flatMap((node) => {
    const evidence = uniqueEvidence(architectureRuntimeSources(node, context.sources).filter((source) => rule.path.test(source.path)).flatMap((source) => {
      const match = findArchitectureEvidence(source, rule.markers, `${rule.id}-callback`);
      return match ? [match] : [];
    }));
    return evidence.length > 0 ? [factEdge(`callback:${rule.id}->${node.id}`, rule.id, node.id, "callback", rule.label, evidence, signalIdsForPaths(context.signals, evidence.map((item) => item.path)))] : [];
  }));
}

export const externalArchitectureDetector: ArchitectureDetector = { id: "external-sdk-usage", detect: detectExternal };
