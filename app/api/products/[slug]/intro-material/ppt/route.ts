import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { getProductDetails } from "@/lib/product-details";
import { renderIntroMaterialMarkdown, toConfirmedOutline } from "@/lib/intro-material";
import { loadIntroMaterial, updatePptFields } from "@/lib/intro-material-service";
import { createPptJob, getPptJobStatus, PptPartnerError, requirePptPartnerConfig } from "@/lib/ppt-partner";
import { enforceExportRateLimit } from "@/lib/rate-limit";

/**
 * PPT 烧片动线（GTM 桥面批次 2）：以已生成的大纲为锁脊输入，提交 PPTCreator
 * create_ppt_from_documents(confirmed_outline, stage=pptx) 异步任务；GET 轮询状态并回写。
 * 预签名下载链接 5 分钟有效，不在本地持久化——下载经 /ppt/download 现取现转。
 */

async function currentMaterial(slug: string, organizationId: number | undefined, productId: number) {
  const details = await getProductDetails(slug, organizationId);
  const specVersionId = details?.releases[0]?.specVersionId ?? null;
  return { material: await loadIntroMaterial(getDb().execute.bind(getDb()), productId, specVersionId), productName: details?.product.name ?? slug };
}

function partnerError(error: unknown) {
  if (error instanceof PptPartnerError) return NextResponse.json({ error: `${error.code}: ${error.message}` }, { status: error.code === "not_configured" ? 501 : 502 });
  return NextResponse.json({ error: `PPT 服务调用失败：${error instanceof Error ? error.message : "未知错误"}` }, { status: 502 });
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
  const { material, productName } = await currentMaterial(slug, access.product.organizationId, access.product.id);
  if (!material) return NextResponse.json({ error: "请先生成介绍材料大纲" }, { status: 404 });

  const outline = toConfirmedOutline(material.draft);
  try {
    const config = requirePptPartnerConfig();
    const jobId = `cd-intro-${material.id}-${Date.now()}`;
    const snapshot = await createPptJob(config, {
      jobId,
      title: `${productName} 介绍`,
      factsMarkdown: renderIntroMaterialMarkdown({ productName, draft: material.draft, coverageNote: null }),
      outline,
    });
    await updatePptFields(getDb().execute.bind(getDb()), material.id, { pptProjectId: snapshot.projectId, pptJobId: jobId, pptStatus: snapshot.status, pptError: null });
    return NextResponse.json({ jobId, projectId: snapshot.projectId, status: snapshot.status });
  } catch (error) {
    return partnerError(error);
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const limited = await enforceExportRateLimit(request, user.sub, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = await requireProductAccess(user, slug, "viewer");
  if (!access) return NextResponse.json({ error: "产品不存在或无访问权限" }, { status: 404 });
  const { material } = await currentMaterial(slug, access.product.organizationId, access.product.id);
  if (!material?.pptProjectId || !material.pptJobId) {
    return NextResponse.json({ status: material?.pptStatus ?? null, projectId: material?.pptProjectId ?? null });
  }
  try {
    const config = requirePptPartnerConfig();
    const snapshot = await getPptJobStatus(config, material.pptJobId, material.pptProjectId);
    await updatePptFields(getDb().execute.bind(getDb()), material.id, { pptStatus: snapshot.status, pptError: snapshot.error ?? null });
    return NextResponse.json({ status: snapshot.status, projectId: snapshot.projectId, error: snapshot.error ?? null, ready: snapshot.status === "COMPLETED" });
  } catch (error) {
    return partnerError(error);
  }
}
