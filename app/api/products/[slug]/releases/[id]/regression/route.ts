import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { loadRegressionTasks, renderRegressionTaskMarkdown } from "@/lib/regression-tasks";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { resolvePublicDemoProduct } from "@/lib/public-demo";
import { enforceExportRateLimit } from "@/lib/rate-limit";
import type { BehaviorChangeRow, ReleaseRow } from "@/lib/types";

/** 回归清单导出：登录成员按工作区读取；公开 demo 产品允许匿名只读（与页面 demo 视图同权）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await context.params;
  const user = await getSessionUser();
  const limited = await enforceExportRateLimit(request, user?.sub ?? null, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = user ? await requireProductAccess(user, slug) : null;
  let product: { id: number; name: string };
  if (access) {
    product = access.product;
  } else {
    const demo = await resolvePublicDemoProduct(slug);
    if (!demo) return NextResponse.json({ error: user ? "产品不存在或不属于当前工作区" : "未登录" }, { status: user ? 404 : 401 });
    product = demo;
  }

  const releaseId = Number(id);
  if (!Number.isInteger(releaseId) || releaseId <= 0) return NextResponse.json({ error: "发布不存在" }, { status: 404 });

  const db = getDb();
  const [releaseRows] = await db.execute(
    "SELECT id, title, summary, sha, url, committed_at AS committedAt, spec_version_id AS specVersionId FROM releases WHERE id = ? AND product_id = ?",
    [releaseId, product.id],
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

  const tasks = (await loadRegressionTasks(product.id)).filter((task) => task.releaseId === releaseId);
  const markdown = renderRegressionTaskMarkdown({ productName: product.name, release, changes, tasks });
  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-regression-${releaseId}.md"`,
    },
  });
}
