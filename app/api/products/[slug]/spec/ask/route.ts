import { NextRequest, NextResponse } from "next/server";
import { answerSpecQuestion, buildAnswerSynthesisPrompt, decorateSpecAnswer, loadSpecAnswerContext, parseAnswerSynthesis } from "@/lib/spec-ask";
import { resolveSpecReadProductId } from "@/lib/spec-read-access";
import { requestStructuredCompletion } from "@/lib/ai";
import { enforceExportRateLimit } from "@/lib/rate-limit";

/**
 * B2.1 检索式问答 + B2.2 AI 综合回答（2026-11-12 真实使用反馈升级）：
 * 检索命中后，AI 只基于命中条目成文（严格禁编造、used 锚点登记、条目不足如实拒答），
 * 原文卡片始终随响应返回作溯源。计费 = receipt-only（call_kind='spec_ask_answer'，免费口径）。
 * 匿名限流 10/时·IP（该端点会花 AI 成本）。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const limited = await enforceExportRateLimit(request, null, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = await resolveSpecReadProductId(slug);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const question = request.nextUrl.searchParams.get("q") ?? "";
  const answer = await answerSpecQuestion(access.productId, question);
  const context_ = await loadSpecAnswerContext(access.productId);
  const decorated = decorateSpecAnswer(answer, context_);

  if (decorated.status !== "matched") {
    return NextResponse.json({ ...decorated, aiAnswer: null });
  }

  // B2.2：AI 综合回答（best-effort——失败时 aiAnswer 缺省，前端回退为纯卡片，不阻塞检索结果）
  try {
    const content = await requestStructuredCompletion(
      [
        { role: "system", content: "你是产品规格问答编辑：只基于给定规格条目回答，禁止编造；不足时如实拒答。" },
        { role: "user", content: buildAnswerSynthesisPrompt({
          question: decorated.question,
          specVersionId: context_.specVersionId,
          features: decorated.features.map((feature) => ({ id: feature.id, name: feature.name, summary: feature.summary })),
          scenarios: decorated.scenarios.map((scenario) => ({ id: scenario.id, featureName: scenario.featureName, reference: scenario.reference, context: scenario.context, action: scenario.action, outcome: scenario.outcome })),
        }) },
      ],
      { runId: null, accountId: null, chargeComponent: "main", callKind: "spec_ask_answer" },
    );
    const synthesis = parseAnswerSynthesis(content);
    if (synthesis.answerable) {
      return NextResponse.json({ ...decorated, aiAnswer: { answer: synthesis.answer, used: synthesis.used } });
    }
    // 模型如实拒答：条目不足以成文
    return NextResponse.json({ ...decorated, aiAnswer: null, answerInsufficient: true });
  } catch (error) {
    console.warn("[spec-ask] answer synthesis failed; falling back to raw cards", { slug, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
    return NextResponse.json(decorated);
  }
}
