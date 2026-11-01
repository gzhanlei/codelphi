import { z } from "zod";
import { requiredEnv } from "./env";
import type { SourceFile } from "./github";

const evidenceSchema = z.object({
  path: z.string().min(1).max(500),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  url: z.string().url().regex(/^https:\/\//i).optional(),
  note: z.string().max(500).optional(),
});

const scenarioSchema = z.object({
  reference: z.string().regex(/^(?:HP|EC|ER)-\d+$/),
  context: z.string().min(1).max(2_000),
  action: z.string().min(1).max(2_000),
  outcome: z.string().min(1).max(2_000),
  category: z.enum(["happy", "edge", "error"]),
  evidence: z.array(evidenceSchema).max(5),
});

export const analysisSchema = z.object({
  release: z.object({
    title: z.string().min(1).max(300),
    summary: z.string().min(1).max(8_000),
  }),
  changes: z.array(z.object({
    featureName: z.string().min(1).max(191),
    kind: z.enum(["added", "changed", "removed", "fixed", "reviewed"]),
    description: z.string().min(1).max(4_000),
    userImpact: z.string().max(4_000).default(""),
    evidence: z.array(evidenceSchema).max(5),
  })).max(150),
  features: z.array(z.object({
    name: z.string().min(1).max(191),
    summary: z.string().min(1).max(4_000),
    scenarios: z.array(scenarioSchema).max(40),
  })).min(1).max(50),
});

export type AnalysisResult = z.infer<typeof analysisSchema>;

export function parseAnalysisContent(content: string): AnalysisResult {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI response did not contain a JSON object");
  return analysisSchema.parse(JSON.parse(trimmed.slice(start, end + 1)));
}

interface ChangeContext {
  message: string;
  files: Array<{ path: string; status: string; patch: string }>;
}

function chatCompletionsUrl() {
  const configured = (process.env.AI_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
  if (configured.endsWith("/v1/chat/completions")) return configured;
  if (configured.endsWith("/v1")) return `${configured}/chat/completions`;
  return `${configured}/v1/chat/completions`;
}

export async function analyzeWithAI(sources: SourceFile[], change: ChangeContext): Promise<AnalysisResult> {
  const prompt = [
    "你在维护一个内部产品知识库。仅根据给定代码和 diff 输出事实，不要补充猜测。",
    "用简体中文生成：1) 当前产品功能规格；2) 本次发布的用户可感知变化。",
    "规格按功能组织，每个场景包含情境、操作、结果，分类为 happy/edge/error，reference 使用 HP-n/EC-n/ER-n。",
    "每个场景和变化必须给 evidence；path 必须来自输入文件，startLine 使用输入的行号。没有用户变化的发布只生成 reviewed 项。",
    "只返回 JSON，不要 Markdown。结构：",
    '{"release":{"title":"","summary":""},"changes":[{"featureName":"","kind":"added|changed|removed|fixed|reviewed","description":"","userImpact":"","evidence":[{"path":"","startLine":1}]}],"features":[{"name":"","summary":"","scenarios":[{"reference":"HP-1","context":"","action":"","outcome":"","category":"happy","evidence":[{"path":"","startLine":1}]}]}]}',
    `\n【本次提交】\n${change.message}\n\n【文件变化】\n${JSON.stringify(change.files).slice(0, 70_000)}`,
    `\n【当前代码，带行号】\n${sources.map((file) => `\n--- ${file.path} ---\n${file.content}`).join("\n")}`,
  ].join("\n");

  const response = await fetch(chatCompletionsUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("AI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: requiredEnv("AI_MODEL"),
      messages: [
        { role: "system", content: "你是严谨的代码分析器，只输出可验证的结构化事实。" },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 16_000,
      stream: false,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS ?? 180_000)),
  });
  if (!response.ok) throw new Error(`AI gateway ${response.status}: ${await response.text()}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI gateway returned empty content");
  return parseAnalysisContent(content);
}
