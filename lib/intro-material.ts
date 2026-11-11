/**
 * 【已暂停 2026-11-11，用户裁决】介绍材料/PPT 生成押后：PPT 不能只基于代码，
 * 还需要产品与市场分析等输入；本模块（含 service/定位块/迁移 061–063）保留为
 * 休眠资产，git 历史 d321315 可整体恢复。当前对外生成面只保留 release notes。
 */
import { z } from "zod";
import { evidenceItems } from "./evidence";
import { publishOrder, type ReleaseNoteChange } from "./release-notes";

/**
 * 介绍材料生成核心（GTM 桥面批次 2）：从行为账本组装事实清单 → AI 生成结构化大纲
 * （每页可直通 PPTCreator confirmed_outline）→ 锚定校验。仿 lib/ai.ts 提取式惯例：
 * 温度 0、JSON 模板逐字给定、fence 剥离、zod 校验；事实/主张分层——定位块是人工输入，
 * 生成物里只能逐字引用，不得当作事实扩写。门禁（仿 validateDraft 的引用存在性校验）：
 * 每个锚点必须解析到事实清单，否则整稿拒绝落库。
 */

export interface IntroPositioning {
  audience: string;
  differentiation: string;
  tone: string;
}

export interface IntroFactFeature {
  id: number;
  name: string;
  summary: string;
  scenarioCount: number;
  source: string;
}

export interface IntroFactChange {
  id: number;
  releaseId: number;
  featureName: string;
  summary: string;
  highlightType: string | null;
}

export interface IntroFactPack {
  productName: string;
  description: string;
  descriptionSource: string;
  features: IntroFactFeature[];
  highlights: IntroFactChange[];
  latestRelease: { id: number; title: string; summary: string } | null;
  trust: { featureCount: number; scenarioCount: number; manualFeatureCount: number; manualScenarioCount: number; evidencePathCount: number };
  coverageNote: string | null;
  positioning: IntroPositioning | null;
}

/** 大纲页锚点：kind=manual 表示来自定位块的人工主张（不指向账本行）。 */
export interface IntroSlideDraft {
  slideType: "COVER" | "CONTENT" | "BACK_COVER";
  section: string;
  title: string;
  keyPoints: string[];
  notes: string;
  anchors: Array<{ kind: "feature" | "change" | "release" | "manual"; id: number }>;
}

export interface IntroMaterialDraft {
  specVersionId: number | null;
  slides: IntroSlideDraft[];
}

const MAX_FACT_FEATURES = 12;
const MAX_FACT_CHANGES = 12;

/** 从产品详情组装事实清单（纯函数；details 由 getProductDetails 提供）。 */
export function buildIntroFactPack(input: {
  product: { name: string; description: string; descriptionSource?: string; positioning?: IntroPositioning | null };
  features: Array<{ id: number; name: string; summary: string; source: string }>;
  scenarios: Array<{ featureId: number; source: string; evidence: unknown }>;
  behaviorChanges: Array<Pick<ReleaseNoteChange, "id" | "featureName" | "summary"> & { releaseId: number; highlightType?: string | null; kind: string }>;
  releases: Array<{ id: number; title: string; summary: string }>;
  coverage?: { coverageRatio: number; implFilesAssembled: number; implFilesTotal: number; partitionsUsed: number } | null;
}): IntroFactPack {
  const toFactChange = (change: { id: number; releaseId: number; featureName: string; summary: string; highlightType?: string | null }): IntroFactChange => ({
    id: change.id,
    releaseId: change.releaseId,
    featureName: change.featureName,
    summary: change.summary,
    highlightType: change.highlightType ?? null,
  });
  const highlights = publishOrder(
    input.behaviorChanges
      .filter((change) => change.highlightType)
      .map((change) => ({ ...toFactChange(change), evidencePaths: [] as string[], entityType: "scenario" as const, scenarioReference: "", kind: "added" as const })),
  )
    .slice(0, MAX_FACT_CHANGES)
    .map((change) => ({ id: change.id, releaseId: change.releaseId, featureName: change.featureName, summary: change.summary, highlightType: change.highlightType }));
  const latestRelease = input.releases[0] ?? null;
  const recentAdded = latestRelease
    ? input.behaviorChanges.filter((change) => change.releaseId === latestRelease.id && change.kind === "added").slice(0, MAX_FACT_CHANGES).map((change) => toFactChange(change))
    : [];
  const evidencePathCount = new Set(input.scenarios.flatMap((scenario) => evidenceItems(scenario.evidence).map((item) => item.path))).size;
  return {
    productName: input.product.name,
    description: input.product.description,
    descriptionSource: input.product.descriptionSource ?? "manual",
    features: input.features
      .map((feature) => ({
        id: feature.id,
        name: feature.name,
        summary: feature.summary,
        scenarioCount: input.scenarios.filter((scenario) => scenario.featureId === feature.id).length,
        source: feature.source,
      }))
      .sort((a, b) => b.scenarioCount - a.scenarioCount)
      .slice(0, MAX_FACT_FEATURES),
    highlights: [...highlights, ...recentAdded]
      .filter((change, index, all) => all.findIndex((item) => item.id === change.id) === index)
      .slice(0, MAX_FACT_CHANGES),
    latestRelease: latestRelease ? { id: latestRelease.id, title: latestRelease.title, summary: latestRelease.summary } : null,
    trust: {
      featureCount: input.features.length,
      scenarioCount: input.scenarios.length,
      manualFeatureCount: input.features.filter((feature) => feature.source === "manual").length,
      manualScenarioCount: input.scenarios.filter((scenario) => scenario.source === "manual").length,
      evidencePathCount,
    },
    coverageNote: input.coverage
      ? `证据覆盖率 ${(input.coverage.coverageRatio * 100).toFixed(1)}%（装配 ${input.coverage.implFilesAssembled}/${input.coverage.implFilesTotal} 个实现文件，${input.coverage.partitionsUsed} 趟提取）`
      : null,
    positioning: input.product.positioning ?? null,
  };
}

export function buildIntroPrompt(factPack: IntroFactPack): string {
  const facts = {
    product: { name: factPack.productName, description: factPack.description },
    features: factPack.features.map((feature) => ({ anchor: { kind: "feature", id: feature.id }, name: feature.name, summary: feature.summary, scenarioCount: feature.scenarioCount, source: feature.source })),
    highlights: factPack.highlights.map((change) => ({ anchor: { kind: "change", id: change.id }, featureName: change.featureName, summary: change.summary, highlightType: change.highlightType })),
    latestRelease: factPack.latestRelease ? { anchor: { kind: "release", id: factPack.latestRelease.id }, title: factPack.latestRelease.title, summary: factPack.latestRelease.summary } : null,
    trust: factPack.trust,
    coverageNote: factPack.coverageNote,
  };
  return [
    "你在为产品生成一份对外介绍材料的大纲（每页将渲染为一页 PPT）。用简体中文。",
    "硬规则：",
    "1. 只使用【事实清单】里给出的事实；每个引用事实的要点必须带 anchor；禁止编造清单里没有的功能、数字或变化。",
    "2. 【定位主张】是产品负责人的人工输入，只能逐字引用并 anchor 到 {\"kind\":\"manual\",\"id\":0}，不得改写或当作事实扩写；未提供定位时跳过差异化页。",
    "3. 可信度页只能照抄 coverageNote 与 trust 数字，不得推算或四舍五入成别的口径。",
    "4. 第 1 页 slideType=COVER；最后 1 页 slideType=BACK_COVER（来源与可信度说明）；中间 3-8 页 slideType=CONTENT。",
    "5. 每页 notes 非空（2-4 句讲稿）；CONTENT 页 keyPoints 至少 1 条、至多 6 条；title ≤ 40 字；每个要点 ≤ 120 字。",
    "只返回 JSON，不要 Markdown。结构：",
    '{"slides":[{"slideType":"COVER|CONTENT|BACK_COVER","section":"能力|差异化|近期亮点|可信度","title":"","keyPoints":[""],"notes":"","anchors":[{"kind":"feature|change|release|manual","id":0}]}]}',
    `\n【事实清单】\n${JSON.stringify(facts)}`,
    `\n【定位主张】\n${factPack.positioning ? JSON.stringify(factPack.positioning) : "未提供：跳过差异化页，不要虚构定位。"}`,
  ].join("\n");
}

const slideSchema = z.object({
  slideType: z.enum(["COVER", "CONTENT", "BACK_COVER"]),
  section: z.string().max(40).default(""),
  title: z.string().min(1).max(200),
  keyPoints: z.array(z.string().min(1).max(500)).max(20).default([]),
  notes: z.string().max(4000).default(""),
  anchors: z
    .array(z.object({ kind: z.enum(["feature", "change", "release", "manual"]), id: z.number().int() }))
    .max(30)
    .default([]),
});

const materialSchema = z.object({ slides: z.array(slideSchema).min(2).max(30) });

/** 剥 fence、取首个 { 到末个 } 的片段（仿 lib/ai.ts parseAnalysisContent）。 */
function parseJsonContent(content: string): unknown {
  const stripped = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 输出不含 JSON 结构");
  return JSON.parse(stripped.slice(start, end + 1));
}

export function parseIntroMaterial(content: string): IntroMaterialDraft {
  const parsed = materialSchema.safeParse(parseJsonContent(content));
  if (!parsed.success) {
    throw new Error(`AI 大纲结构不合格：${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  }
  return {
    specVersionId: null,
    slides: parsed.data.slides.map((slide) => ({
      slideType: slide.slideType,
      section: slide.section,
      title: slide.title,
      keyPoints: slide.keyPoints,
      notes: slide.notes,
      anchors: slide.anchors,
    })),
  };
}

export type IntroDraftValidation = { ok: true } | { ok: false; error: string };

/**
 * 锚定校验（发布前与落库前都跑）：锚点必须解析到事实清单；PPTCreator 硬规则——
 * 每页 notes 非空（notes_missing 会整单失败）、CONTENT 页 keyPoints 非空（empty_slide）。
 */
export function validateIntroDraft(draft: IntroMaterialDraft, factPack: IntroFactPack): IntroDraftValidation {
  const featureIds = new Set(factPack.features.map((feature) => feature.id));
  const changeIds = new Set(factPack.highlights.map((change) => change.id));
  const releaseId = factPack.latestRelease?.id ?? null;
  for (const [index, slide] of draft.slides.entries()) {
    const label = `第 ${index + 1} 页（${slide.title.slice(0, 20)}）`;
    if (!slide.notes.trim()) return { ok: false, error: `${label} 缺讲稿（notes 非空是 PPT 渲染的硬规则）` };
    if (slide.slideType === "CONTENT") {
      if (slide.keyPoints.length === 0) return { ok: false, error: `${label} 没有要点（CONTENT 页至少 1 条 keyPoint）` };
      if (slide.anchors.length === 0) return { ok: false, error: `${label} 没有任何锚点：内容必须可追溯到账本或标注 manual 主张` };
    }
    for (const anchor of slide.anchors) {
      if (anchor.kind === "feature" && !featureIds.has(anchor.id)) return { ok: false, error: `${label} 锚定的功能 #${anchor.id} 不在事实清单内` };
      if (anchor.kind === "change" && !changeIds.has(anchor.id)) return { ok: false, error: `${label} 锚定的变化 #${anchor.id} 不在事实清单内` };
      if (anchor.kind === "release" && anchor.id !== releaseId) return { ok: false, error: `${label} 锚定的发布 #${anchor.id} 不是当前最新发布` };
    }
  }
  const first = draft.slides[0];
  const last = draft.slides[draft.slides.length - 1];
  if (first?.slideType !== "COVER") return { ok: false, error: "第 1 页必须是 COVER" };
  if (last?.slideType !== "BACK_COVER") return { ok: false, error: "最后 1 页必须是 BACK_COVER" };
  return { ok: true };
}

/** 映射为 PPTCreator confirmed_outline（锁脊烧片输入；页序与措辞逐字锁定）。 */
export function toConfirmedOutline(draft: IntroMaterialDraft): PptOutlineDraftSlide[] {
  return draft.slides.map((slide, index) => ({
    order: index + 1,
    type: slide.slideType,
    title: slide.title,
    ...(slide.section ? { chapter: slide.section } : {}),
    keyPoints: slide.keyPoints,
    notes: slide.notes,
  }));
}

export interface PptOutlineDraftSlide {
  order: number;
  type: "COVER" | "CONTENT" | "BACK_COVER";
  title: string;
  chapter?: string;
  keyPoints?: string[];
  notes?: string;
}

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderIntroMaterialMarkdown(input: { productName: string; draft: IntroMaterialDraft; coverageNote: string | null; publicNote?: string }): string {
  const lines = [`# ${input.productName} 介绍大纲`, ""];
  if (input.coverageNote) lines.push(`> 口径：${input.coverageNote}。分析成功 ≠ 完整 ≠ 正确，采纳前应经人工核实。`, "");
  for (const slide of input.draft.slides) {
    lines.push(`## [${slide.slideType}]${slide.section ? `（${slide.section}）` : ""} ${slide.title}`, "");
    for (const point of slide.keyPoints) lines.push(`- ${point}`);
    if (slide.notes) lines.push("", `讲稿：${slide.notes}`);
    if (slide.anchors.length > 0) lines.push("", `锚点：${slide.anchors.map((anchor) => `${anchor.kind}#${anchor.id}`).join("、")}`);
    lines.push("");
  }
  if (input.publicNote) lines.push(input.publicNote);
  return lines.join("\n");
}

export function renderIntroMaterialHtml(input: { productName: string; draft: IntroMaterialDraft; coverageNote: string | null }): string {
  const sections = input.draft.slides
    .map((slide) => `<section class="slide"><div class="meta">[${esc(slide.slideType)}]${slide.section ? ` · ${esc(slide.section)}` : ""}</div><h2>${esc(slide.title)}</h2><ul>${slide.keyPoints.map((point) => `<li>${esc(point)}</li>`).join("")}</ul>${slide.notes ? `<p class="notes">${esc(slide.notes)}</p>` : ""}</section>`)
    .join("\n");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(input.productName)} 介绍材料 · CoDelphi</title><style>body{font-family:system-ui;max-width:760px;margin:8vh auto;padding:0 16px;color:#1a1a1a}.slide{border-top:1px solid #eee;padding:14px 0}.meta{font-size:12px;color:#666}.notes{font-size:13px;color:#555}.disclaimer{font-size:12px;color:#888;margin-top:24px}</style></head><body>
<h1>${esc(input.productName)} 介绍材料</h1>
${sections}
<p class="disclaimer">${input.coverageNote ? esc(input.coverageNote) + "。分析成功 ≠ 完整 ≠ 正确，采纳前应经人工核实。" : ""}由 CoDelphi 从行为账本生成，每页要点可追溯到规格事实（锚点见导出 Markdown）；差异化主张为人工输入。</p>
</body></html>`;
}
