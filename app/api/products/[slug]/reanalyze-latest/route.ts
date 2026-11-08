import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { queueAnalysis, runAnalysis } from "@/lib/analysis";
import { resolveManualAnalysis } from "@/lib/manual-analysis";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { BillingError, billingHttpStatus } from "@/lib/billing/core";
import { after } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({ confirm: z.literal(true) });

/** 补分析最新 SHA（契约 §12.4.5/§8.2.4）：显式入口、只补最新一次成功发布；新 requestId 独立计费（§6.6）。 */
export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "product_not_found" }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    // 双击/误触防护：必须显式 confirm=true
    return NextResponse.json({ error: "confirm_required", message: "补分析将按新任务正常计费，请确认后重试" }, { status: 400 });
  }
  const analysis = await resolveManualAnalysis(slug, access.product.organizationId);
  if (!analysis) return NextResponse.json({ error: "product_not_found" }, { status: 404 });

  // 最新一次成功发布的 SHA（规格与该代码状态同步；无成功发布则回退当前 HEAD）
  const [releaseRows] = await getDb().execute(
    `SELECT r.sha FROM releases r WHERE r.product_id = ? AND r.sha IS NOT NULL ORDER BY r.committed_at DESC LIMIT 1`,
    [access.product.id],
  );
  const targetSha = (releaseRows as Array<{ sha: string }>)[0]?.sha ?? analysis.afterSha;

  try {
    const runId = await queueAnalysis(analysis.repositoryId, null, targetSha, "manual");
    after(() => runAnalysis(runId));
    return NextResponse.json({ accepted: true, runId, sha: targetSha }, { status: 202 });
  } catch (error) {
    if (error instanceof BillingError) {
      return NextResponse.json(
        { error: error.code, message: `补分析未执行：${error.code === "quota_exceeded" ? "额度不足，请升级或购买超额包后重试" : "当前账户状态不允许新分析"}` },
        { status: billingHttpStatus(error.code) },
      );
    }
    throw error;
  }
}
