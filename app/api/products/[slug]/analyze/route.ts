import { after, NextRequest, NextResponse } from "next/server";
import { queueAnalysis, runAnalysis } from "@/lib/analysis";
import { resolveManualAnalysis } from "@/lib/manual-analysis";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { availableSau, BillingError, billingHttpStatus } from "@/lib/billing/core";
import { enqueueBillingNotification } from "@/lib/billing/notifications";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "product_not_found" }, { status: 404 });
  const analysis = await resolveManualAnalysis(slug, access.product.organizationId);
  if (!analysis) return NextResponse.json({ error: "product_not_found" }, { status: 404 });

  let runId: number;
  try {
    runId = await queueAnalysis(analysis.repositoryId, null, analysis.afterSha, "manual");
  } catch (error) {
    // 额度闸门拒绝（契约 §12.2）：不进入队列、不产生 LLM 调用，返回可理解的升级/超额指引语义
    if (error instanceof BillingError) {
      if (error.code === "quota_exceeded") {
        const available = await availableSau(access.product.organizationId).catch(() => null);
        await enqueueBillingNotification({
          accountId: access.product.organizationId,
          billingPeriod: "trial",
          type: "quota_exceeded_rejected",
          threshold: 0,
          subject: "[CoDelphi] 额度不足，分析未执行",
          body: "可用额度已耗尽，本次分析未执行。请升级套餐或购买超额包后重试；历史规格不受影响。",
        }).catch(() => false);
        return NextResponse.json(
          { error: error.code, message: "额度不足：本次分析未执行。请升级套餐或购买超额包后重试。", available },
          { status: 402 },
        );
      }
      return NextResponse.json({ error: error.code }, { status: billingHttpStatus(error.code) });
    }
    throw error;
  }
  after(() => runAnalysis(runId));
  return NextResponse.json({ accepted: true, runId }, { status: 202 });
}
