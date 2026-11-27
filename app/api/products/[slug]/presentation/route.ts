import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { schedulePresentationRefresh, standalonePresentationBilling } from "@/lib/product-presentation-service";
import { errorMessage } from "@/lib/error-message";
import { MODEL_NOT_CONFIGURED, MODEL_REQUIRED_RESPONSE_MESSAGE } from "@/lib/analysis-executor";

/**
 * 手动刷新产品理解层（核心能力归纳 + 典型使用场景）：编辑者及以上可用，无视节流间隔。
 * 生成在后台执行（行级租约与分析钩子 / sweep 互斥），这里不等待模型调用，立即返回 202 与调度结果；
 * 调用方刷新页面即可看到新内容。模型调用按独立生成口径记账（call_kind=product_presentation）。
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  if (access.role === "viewer") return NextResponse.json({ error: "无权限" }, { status: 403 });
  try {
    const result = await schedulePresentationRefresh({ productId: access.product.id, force: true, billing: standalonePresentationBilling() });
    // 工作区没有自己的模型：CoDelphi 不替用户付模型费用，不生成。告诉用户去哪里配。
    if (result.outcome === "skipped" && result.reason === MODEL_NOT_CONFIGURED) {
      return NextResponse.json({ error: result.reason, message: MODEL_REQUIRED_RESPONSE_MESSAGE }, { status: 409 });
    }
    return NextResponse.json({ outcome: result.outcome, reason: result.reason ?? null }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error, "理解层刷新失败") }, { status: 500 });
  }
}
