import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { resolveLegacyPublicDemoProduct } from "@/lib/public-demo";
import { loadAffectedScenarios } from "@/lib/spec-file-index";
import { resolveFeatureByStableKey } from "@/lib/stable-links";

const MAX_FILES = 50;

const filesSchema = z.string().min(1)
  .transform((value) => [...new Set(value.split(",").map((path) => path.trim()).filter(Boolean))])
  .refine((list) => list.length >= 1 && list.length <= MAX_FILES, { message: `files 需要至少 1 个、最多 ${MAX_FILES} 个路径` });
const querySchema = z.object({ files: filesSchema });

/** C2 事前影响分析 spike：给定文件清单 → 最新规格里受影响的功能与场景。只读，不改任何状态。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "参数无效：需要 files=逗号分隔的文件路径（最多 50 个）" }, { status: 400 });

  const user = await getSessionUser();
  const access = user ? await requireProductAccess(user, slug) : null;
  let productId: number;
  if (access) {
    productId = access.product.id;
  } else {
    const demo = await resolveLegacyPublicDemoProduct(slug);
    if (!demo) return NextResponse.json({ error: user ? "产品不存在或不属于当前工作区" : "未登录" }, { status: user ? 404 : 401 });
    productId = demo.id;
  }

  const [repoRows] = await getDb().execute("SELECT id FROM repositories WHERE product_id = ? LIMIT 1", [productId]);
  const repositoryId = Number((repoRows as Array<{ id: number }>)[0]?.id ?? 0);
  if (!repositoryId) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });

  const raw = await loadAffectedScenarios(repositoryId, parsed.data.files);
  // stable_key → 工作台层 feature id（M3 稳定引用同源通道）：结果链接必须落在规格页真实可打开的功能上，
  // 版本层 spec_features.id 不是规格页的寻址空间；条目已退役时为 null，前端降级为无链接展示。
  const affected = [];
  for (const impact of raw) {
    const featureId = impact.stableKey ? await resolveFeatureByStableKey(productId, impact.stableKey) : null;
    affected.push({ featureId, feature: impact.feature, scenarios: impact.scenarios });
  }
  return NextResponse.json({ files: parsed.data.files, affected });
}
