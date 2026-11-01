import { after, NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { queueAnalysis, runAnalysis } from "@/lib/analysis";
import { getDb } from "@/lib/db";
import { getBranchHead, getRepository, parseRepository } from "@/lib/github";
import { productInputSchema } from "@/lib/product-input";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  await requireSessionUser();
  try {
    const input = productInputSchema.parse(await request.json());
    const repository = parseRepository(input.repository);
    const metadata = await getRepository(repository);
    const defaultBranch = input.defaultBranch || metadata.defaultBranch;
    const afterSha = await getBranchHead({ ...repository, defaultBranch });

    const db = getDb();
    const connection = await db.getConnection();
    let productId: number;
    let repositoryId: number;
    try {
      await connection.beginTransaction();
      const [productResult] = await connection.execute(
        "INSERT INTO products (slug, name, description) VALUES (?, ?, ?)",
        [input.slug, input.name, input.description],
      );
      productId = Number((productResult as { insertId: number }).insertId);
      const [repositoryResult] = await connection.execute(
        "INSERT INTO repositories (product_id, owner, name, default_branch) VALUES (?, ?, ?, ?)",
        [productId, repository.owner, repository.name, defaultBranch],
      );
      repositoryId = Number((repositoryResult as { insertId: number }).insertId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const runId = input.analyze ? await queueAnalysis(repositoryId, null, afterSha, "manual") : null;
    if (runId) after(() => runAnalysis(runId));
    return NextResponse.json({ slug: input.slug, runId }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? "输入无效" }, { status: 400 });
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY") {
      return NextResponse.json({ error: "产品 Slug 或 GitHub 仓库已经注册" }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "添加产品失败，请检查仓库名称和访问权限" },
      { status: 400 },
    );
  }
}
