import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { resolvePublicDemoProduct } from "@/lib/public-demo";
import { loadAffectedScenarios } from "@/lib/spec-file-index";

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
    const demo = await resolvePublicDemoProduct(slug);
    if (!demo) return NextResponse.json({ error: user ? "产品不存在或不属于当前工作区" : "未登录" }, { status: user ? 404 : 401 });
    productId = demo.id;
  }

  const [repoRows] = await getDb().execute("SELECT id FROM repositories WHERE product_id = ? LIMIT 1", [productId]);
  const repositoryId = Number((repoRows as Array<{ id: number }>)[0]?.id ?? 0);
  if (!repositoryId) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });

  const affected = await loadAffectedScenarios(repositoryId, parsed.data.files);
  return NextResponse.json({ files: parsed.data.files, affected });
}
