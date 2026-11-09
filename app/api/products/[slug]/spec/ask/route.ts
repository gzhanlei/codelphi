import { NextRequest, NextResponse } from "next/server";
import { answerSpecQuestion } from "@/lib/spec-ask";
import { resolveSpecReadProductId } from "@/lib/spec-read-access";

/** B2.1 站内检索式问答：答案就是规格原文，接口不生成任何新的文字。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const access = await resolveSpecReadProductId(slug);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const question = request.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json(await answerSpecQuestion(access.productId, question));
}
