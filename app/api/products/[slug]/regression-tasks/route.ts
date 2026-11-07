import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setRegressionTask } from "@/lib/regression-tasks";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

const taskSchema = z.object({
  releaseId: z.number().int().positive(),
  taskId: z.number().int().positive(),
  status: z.enum(["pending", "passed", "failed", "skipped"]),
  skipReason: z.string().max(191).optional(),
  failureNote: z.string().max(2000).optional(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  const parsed = taskSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  try {
    await setRegressionTask({
      productId: access.product.id,
      taskId: parsed.data.taskId,
      status: parsed.data.status,
      checkedBy: user.email ?? user.sub,
      skipReason: parsed.data.skipReason ?? null,
      failureNote: parsed.data.failureNote ?? null,
    });
    return NextResponse.json({ status: "saved" });
  } catch (error) {
    if (error instanceof Error && error.message === "regression_task_invalid") {
      return NextResponse.json({ error: "该回归任务不属于此产品" }, { status: 404 });
    }
    throw error;
  }
}
