import { after, NextRequest, NextResponse } from "next/server";
import { queueAnalysis, runAnalysis } from "@/lib/analysis";
import { getDb } from "@/lib/db";
import { getBranchHead, getRepository } from "@/lib/github";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  await requireSessionUser();
  const { slug } = await context.params;
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT r.id, r.owner, r.name, r.default_branch AS defaultBranch
     FROM repositories r JOIN products p ON p.id = r.product_id WHERE p.slug = ? LIMIT 1`,
    [slug],
  );
  const repository = (rows as Array<{ id: number; owner: string; name: string; defaultBranch: string }>)[0];
  if (!repository) return NextResponse.json({ error: "product_not_found" }, { status: 404 });

  const metadata = await getRepository(repository);
  const afterSha = await getBranchHead({ ...repository, ...metadata });
  const runId = await queueAnalysis(repository.id, null, afterSha, "manual");
  after(() => runAnalysis(runId));
  return NextResponse.json({ accepted: true, runId }, { status: 202 });
}
