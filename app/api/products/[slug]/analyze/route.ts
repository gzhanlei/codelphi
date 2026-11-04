import { after, NextRequest, NextResponse } from "next/server";
import { queueAnalysis, runAnalysis } from "@/lib/analysis";
import { getDb } from "@/lib/db";
import { getBranchHead, getRepository } from "@/lib/github";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { slug } = await context.params;
  const db = getDb();
  const [rows] = await db.execute(
    `SELECT r.id, r.owner, r.name, r.default_branch AS defaultBranch, r.connection_id AS connectionId
     FROM repositories r JOIN products p ON p.id = r.product_id WHERE p.slug = ? AND p.organization_id = ? LIMIT 1`,
    [slug, organization.id],
  );
  const repository = (rows as Array<{ id: number; owner: string; name: string; defaultBranch: string; connectionId: number | null }>)[0];
  if (!repository) return NextResponse.json({ error: "product_not_found" }, { status: 404 });

  const access = { connectionId: repository.connectionId, organizationId: organization.id };
  const metadata = await getRepository(repository, access);
  const afterSha = await getBranchHead({ ...repository, ...metadata }, access);
  const runId = await queueAnalysis(repository.id, null, afterSha, "manual");
  after(() => runAnalysis(runId));
  return NextResponse.json({ accepted: true, runId }, { status: 202 });
}
