import { after, NextRequest, NextResponse } from "next/server";
import { queueAnalysis, runAnalysis } from "@/lib/analysis";
import { resolveManualAnalysis } from "@/lib/manual-analysis";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { slug } = await context.params;
  const analysis = await resolveManualAnalysis(slug, organization.id);
  if (!analysis) return NextResponse.json({ error: "product_not_found" }, { status: 404 });

  const runId = await queueAnalysis(analysis.repositoryId, null, analysis.afterSha, "manual");
  after(() => runAnalysis(runId));
  return NextResponse.json({ accepted: true, runId }, { status: 202 });
}
