import { NextRequest, NextResponse } from "next/server";
import { answerSpecQuestion, buildAnswerSynthesisPrompt, decorateSpecAnswer, loadSpecAnswerContext, parseAnswerSynthesis, buildFeatureSelectPrompt, parseFeatureSelection, type SpecAnswer } from "@/lib/spec-ask";
import { getDb } from "@/lib/db";
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
    // B2.2b 词汇鸿沟兜底：词法检索未命中 ≠ 规格没答案（例：问『语言』，条目写的是 Next.js/Go）。
    // 一次 AI 调用从功能清单选相关功能；选出后取其场景走既有综合链路。两次失败如实返回未覆盖。
    try {
      const featureResult = await getDb().execute(
        "SELECT id, name, summary FROM features WHERE product_id = ? AND active = 1 ORDER BY id LIMIT 100",
        [access.productId],
      ) as unknown;
      const featureRows = (Array.isArray(featureResult) ? featureResult[0] : featureResult) as Array<{ id: number; name: string; summary: string }>;
      const catalog = featureRows ?? [];
      if (catalog.length === 0) return NextResponse.json({ ...decorated, aiAnswer: null });
      const [productRow] = (await getDb().execute("SELECT name FROM products WHERE id = ?", [access.productId]) as unknown) as Array<{ name: string }>;
      const productNameForAsk = productRow?.name ?? "";
      const selectCall = () => requestStructuredCompletion(
        [
          { role: "system", content: "你是检索助手，只输出合规 JSON。" },
          { role: "user", content: buildFeatureSelectPrompt({ question: decorated.question, productName: productNameForAsk, catalog: catalog.map((item) => ({ id: item.id, name: item.name, summary: item.summary ?? "" })) }) },
        ],
        { runId: null, accountId: null, chargeComponent: "main", callKind: "spec_ask_answer" },
      );
      const validIds = new Set(catalog.map((item) => item.id));
      const selectContent = await selectCall();
      let relevant = parseFeatureSelection(selectContent, validIds);
      // 模型输出非确定：选择为空时重试一次（两次皆空才如实未覆盖）
      if (relevant.length === 0) {
        const retryContent = await selectCall();
        relevant = parseFeatureSelection(retryContent, validIds);
      }
      if (relevant.length === 0) return NextResponse.json({ ...decorated, aiAnswer: null });
      const idList = relevant.join(",");
      const scenarioResult = await getDb().execute(
        `SELECT s.id, s.feature_id AS featureId, f.name AS featureName, s.reference, s.context, s.action, s.outcome, s.evidence
         FROM scenarios s JOIN features f ON f.id = s.feature_id
         WHERE s.feature_id IN (${idList}) AND s.active = 1 ORDER BY s.feature_id, s.id LIMIT 60`,
      ) as unknown;
      const scenarioRows = (Array.isArray(scenarioResult) ? scenarioResult[0] : scenarioResult) as Array<{
        id: number; featureId: number; featureName: string; reference: string; context: string; action: string; outcome: string; evidence: unknown;
      }>;
      const excerpts = scenarioRows;
      if (excerpts.length === 0) return NextResponse.json({ ...decorated, aiAnswer: null });
      const pickedFeatures = [...new Set(excerpts.map((s) => s.featureId))].map((fid) => {
        const first = excerpts.find((s) => s.featureId === fid)!;
        const catalogItem = catalog.find((item) => item.id === fid);
        return { id: fid, name: first.featureName, summary: catalogItem?.summary ?? "" };
      });
      const scenarioExcerpts = excerpts.map((scenario) => ({ id: scenario.id, featureName: scenario.featureName, reference: scenario.reference, context: scenario.context, action: scenario.action, outcome: scenario.outcome }));
      const featureExcerpts = pickedFeatures.map((feature) => ({ id: feature.id, name: feature.name, summary: feature.summary }));
      const synthesisContent = await requestStructuredCompletion(
        [
          { role: "system", content: "你是产品规格问答编辑：只基于给定规格条目回答，禁止编造；不足时如实拒答。" },
          { role: "user", content: buildAnswerSynthesisPrompt({
            question: decorated.question,
            specVersionId: context_.specVersionId,
            features: featureExcerpts,
            scenarios: scenarioExcerpts,
          }) },
        ],
        { runId: null, accountId: null, chargeComponent: "main", callKind: "spec_ask_answer" },
      );
      const synthesis = parseAnswerSynthesis(synthesisContent);
      if (!synthesis.answerable) {
        return NextResponse.json({ ...decorated, aiAnswer: null, answerInsufficient: true });
      }
      const fallbackAnswer = {
        status: "matched",
        question: decorated.question,
        terms: decorated.terms,
        features: featureExcerpts,
        scenarios: scenarioExcerpts.map((scenario) => ({ ...scenario, evidence: [] as never[] })),
        notice: "以下条目由 AI 从功能清单中匹配（词法检索未命中），成文基于规格原文；点条目可查看完整功能与代码证据。",
      };
      const releaseResult = await getDb().execute("SELECT owner, name FROM repositories WHERE product_id = ? LIMIT 1", [access.productId]) as unknown;
      const repoRows = (Array.isArray(releaseResult) ? releaseResult[0] : releaseResult) as Array<{ owner: string; name: string }>;
      const repo = repoRows?.[0] ?? null;
      const fallback = decorateSpecAnswer(fallbackAnswer as SpecAnswer, { specVersionId: context_.specVersionId, repo: repo ?? null, sha: context_.sha });
      return NextResponse.json({ ...fallback, aiAnswer: { answer: synthesis.answer, used: [] } });
    } catch (error) {
      console.warn("[spec-ask] fallback feature selection failed", { slug, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      return NextResponse.json({ ...decorated, aiAnswer: null });
    }
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
