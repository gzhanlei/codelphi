import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { loadRegressionStatuses, renderRegressionMarkdown } from "@/lib/regression";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import type { BehaviorChangeRow, ReleaseRow } from "@/lib/types";

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const user = await requireSessionUser();
  const { slug, id } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });

  const releaseId = Number(id);
  if (!Number.isInteger(releaseId) || releaseId <= 0) return NextResponse.json({ error: "发布不存在" }, { status: 404 });

  const db = getDb();
  const [releaseRows] = await db.execute(
    "SELECT id, title, summary, sha, url, committed_at AS committedAt, spec_version_id AS specVersionId FROM releases WHERE id = ? AND product_id = ?",
    [releaseId, access.product.id],
  );
  const release = (releaseRows as ReleaseRow[])[0];
  if (!release) return NextResponse.json({ error: "发布不存在" }, { status: 404 });

  const [changeRows] = await db.execute(
    `SELECT id, ? AS releaseId, kind, entity_type AS entityType, feature_name AS featureName,
            scenario_reference AS scenarioReference, summary, before_json AS beforeJson, after_json AS afterJson
     FROM spec_changes WHERE spec_version_id = ? ORDER BY id`,
    [release.id, release.specVersionId],
  );
  const changes = (changeRows as Array<Omit<BehaviorChangeRow, "before" | "after"> & { beforeJson: unknown; afterJson: unknown }>).map((row) => ({
    ...row,
    releaseId: Number(row.releaseId),
    before: row.beforeJson,
    after: row.afterJson,
  })) as BehaviorChangeRow[];

  const statuses = await loadRegressionStatuses(access.product.id);
  const markdown = renderRegressionMarkdown({ productName: access.product.name, release, changes, statuses });
  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-regression-${releaseId}.md"`,
    },
  });
}
