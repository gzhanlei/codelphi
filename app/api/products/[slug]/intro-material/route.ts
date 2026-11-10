import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { getProductDetails } from "@/lib/product-details";
import { requestStructuredCompletion } from "@/lib/ai";
import {
  buildIntroFactPack,
  buildIntroPrompt,
  parseIntroMaterial,
  renderIntroMaterialMarkdown,
  validateIntroDraft,
  type IntroMaterialDraft,
  type IntroPositioning,
} from "@/lib/intro-material";
import { loadIntroMaterial, saveIntroMaterial } from "@/lib/intro-material-service";
import { enforceExportRateLimit } from "@/lib/rate-limit";

/**
 * 介绍材料（GTM 桥面批次 2）：AI 从行为账本事实清单生成结构化大纲，每块带锚点。
 * 计费口径（用户裁决 2026-11-11）：免费 + 如实记账——receipt 落 call_kind='intro_material'，
 * 不扣 SAU。定位块（主张层）只逐字引用；锚定校验不过的整稿拒绝落库。
 */

function readPositioning(value: unknown): IntroPositioning | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
  const positioning = { audience: text("audience"), differentiation: text("differentiation"), tone: text("tone") };
  return positioning.audience || positioning.differentiation || positioning.tone ? positioning : null;
}

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const limited = await enforceExportRateLimit(request, user.sub, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = await requireProductAccess(user, slug, "viewer");
  if (!access) return NextResponse.json({ error: "产品不存在或无访问权限" }, { status: 404 });
  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  const currentSpecVersionId = details.releases[0]?.specVersionId ?? null;
  const material = await loadIntroMaterial(getDb().execute.bind(getDb()), access.product.id, currentSpecVersionId);
  return NextResponse.json({
    currentSpecVersionId,
    positioning: readPositioning(details.product.positioning),
    coverageNote: details.coverage ? `证据覆盖率 ${(details.coverage.coverageRatio * 100).toFixed(1)}%（装配 ${details.coverage.implFilesAssembled}/${details.coverage.implFilesTotal} 个实现文件）` : null,
    material: material
      ? {
          id: material.id,
          specVersionId: material.specVersionId,
          slides: material.draft.slides,
          status: material.status,
          ppt: { projectId: material.pptProjectId, jobId: material.pptJobId, status: material.pptStatus, error: material.pptError },
          updatedAt: material.updatedAt,
        }
      : null,
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const limited = await enforceExportRateLimit(request, user.sub, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或无编辑权限" }, { status: 404 });
  await request.json().catch(() => ({}));
  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  const specVersionId = details.releases[0]?.specVersionId ?? null;
  if (specVersionId === null) return NextResponse.json({ error: "尚未生成规格，先执行一次分析" }, { status: 400 });

  const factPack = buildIntroFactPack({
    product: { name: details.product.name, description: details.product.description, descriptionSource: details.product.descriptionSource, positioning: readPositioning(details.product.positioning) },
    features: details.features,
    scenarios: details.scenarios,
    behaviorChanges: details.behaviorChanges,
    releases: details.releases,
    coverage: details.coverage,
  });

  let draft: IntroMaterialDraft;
  try {
    const content = await requestStructuredCompletion(
      [
        { role: "system", content: "你是严谨的产品介绍撰稿人，只输出可追溯到给定事实的结构化大纲。" },
        { role: "user", content: buildIntroPrompt(factPack) },
      ],
      { runId: null, accountId: null, chargeComponent: "main", callKind: "intro_material" },
    );
    draft = parseIntroMaterial(content);
  } catch (error) {
    return NextResponse.json({ error: `生成失败：${error instanceof Error ? error.message : "AI 调用异常"}` }, { status: 502 });
  }
  draft.specVersionId = specVersionId;
  const validation = validateIntroDraft(draft, factPack);
  if (!validation.ok) {
    // 引用存在性校验（R1 门禁的生成侧）：锚点悬空的大稿不落库，如实返回原因。
    return NextResponse.json({ error: `生成结果未通过锚定校验：${validation.error}` }, { status: 502 });
  }
  const materialId = await saveIntroMaterial(getDb().execute.bind(getDb()), { productId: access.product.id, specVersionId, draft, createdBySub: user.sub });
  const factsMarkdown = renderIntroMaterialMarkdown({ productName: details.product.name, draft, coverageNote: factPack.coverageNote });
  return NextResponse.json({ material: { id: materialId, specVersionId, slides: draft.slides, factsMarkdown } });
}
