"use client";

import { useState } from "react";
import type { DecoratedSpecAnswer } from "@/lib/spec-ask";
import { featureHref } from "@/lib/spec-editor-ui";
import { EvidenceLinks } from "./evidence-links";

/**
 * B2.1 检索式问答：一次问句 → 一组规格原文卡片。
 * 没有对话历史、没有模型新写的文字；未命中明确声明「规格未覆盖」。
 * 显式提交而非逐字触发：一次回答最多会跑 8 组检索，不能绑在每次按键上。
 */
export function SpecAsk({ slug, productBase, suggestions = [] }: { slug: string; productBase: string; suggestions?: string[] }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<DecoratedSpecAnswer | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<Date | null>(null);

  async function ask() {
    const trimmed = question.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setFailed(null);
    setRateLimitedUntil(null);
    try {
      const response = await fetch(`/api/products/${slug}/spec/ask?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
      // 限流必须明说原因与恢复时间，不许笼统化成「查询不可用」。
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? "0");
        const minutes = Math.max(1, Math.ceil(retryAfter / 60));
        setRateLimitedUntil(new Date(Date.now() + retryAfter * 1000));
        setFailed(`提问频率已达上限（每 IP 每小时 10 次），约 ${minutes} 分钟后可再试。`);
        return;
      }
      if (!response.ok) throw new Error(`ask failed: ${response.status}`);
      setAnswer(await response.json() as DecoratedSpecAnswer);
    } catch (cause: unknown) {
      // 限流已在上面明说；其余异常给可见失败态，不静默无结果。
      if (!String((cause as Error)?.message ?? "").includes("提问频率")) setFailed("查询暂时不可用，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="spec-ask">
      <div className="spec-ask-bar">
        <input
          aria-label="向规格提问"
          type="search"
          placeholder="用一句话问产品行为，例如：上传文件最多几个？单个文件最大多大？"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void ask(); }}
        />
        <button className="secondary-button" type="button" onClick={() => void ask()} disabled={pending || question.trim() === ""}>
          {pending ? "查询中…" : "查规格"}
        </button>
      </div>
      {suggestions.length > 0 ? (
        <div className="spec-ask-suggestions">
          {suggestions.map((suggestion) => (
            <button key={suggestion} className="spec-ask-suggestion" type="button" disabled={pending} onClick={() => { setQuestion(suggestion); void ask(); }}>{suggestion}</button>
          ))}
        </div>
      ) : null}
      {rateLimitedUntil ? <p className="spec-search-hint" role="status">提问频率已达上限，{rateLimitedUntil.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 后可再试。</p> : null}
      {failed ? <p className="spec-search-hint" role="alert">{failed}</p> : null}
      {answer ? <SpecAnswerView answer={answer} productBase={productBase} /> : null}
    </div>
  );
}

/** 纯展示：把一次检索答案渲染成规格原文卡片。无 hooks、无 fetch，可在 node 环境用 renderToStaticMarkup 测试。 */
export function SpecAnswerView({ answer, productBase }: { answer: DecoratedSpecAnswer; productBase: string }) {
  return (
    <div className="spec-ask-answer">
      {answer.aiAnswer?.answer ? (
        <div className="spec-ask-ai-answer">
          <div className="spec-ask-ai-label">AI 综合回答 · 仅基于下方规格条目，未采信条目之外的内容</div>
          <p>{answer.aiAnswer.answer}</p>
        </div>
      ) : null}
      <p className={answer.status === "uncovered" ? "spec-ask-uncovered" : "spec-ask-notice"}>{answer.notice}</p>
      {answer.specVersionId !== null ? <p className="spec-ask-version">基于规格版本 #{answer.specVersionId}；未覆盖结论仅对该版本有效。</p> : null}
      {answer.status === "matched" ? (
        <div className="spec-ask-cards">
          {answer.features.map((feature) => (
            <div className="spec-search-hit" key={`f${feature.id}`}>
              <span className="spec-search-kind">功能</span>
              <strong><a className="spec-ask-hit-link" href={`${productBase}${featureHref(feature.id)}`}>{feature.name}</a></strong>
              <p>{feature.summary}</p>
            </div>
          ))}
          {answer.scenarios.slice(0, 8).map((scenario) => (
            // 卡片不能整体包 <a>：证据里的 blob 链接也是 <a>，嵌套链接是无效 HTML。
            <div className="spec-search-hit" key={`s${scenario.id}`}>
              <span className="spec-search-kind">场景</span>
              <strong><a className="spec-ask-hit-link" href={`${productBase}${featureHref(scenario.featureId)}`}>{scenario.featureName} · {scenario.reference}</a></strong>
              <p>{scenario.context} → {scenario.action} → {scenario.outcome}</p>
              <div className="spec-ask-evidence"><EvidenceLinks value={scenario.evidence} /></div>
            </div>
          ))}
          {answer.scenarios.length > 8 ? <p className="spec-ask-hint">其余 {answer.scenarios.length - 8} 条命中条目已省略——可换更具体的问法收窄范围。</p> : null}
        </div>
      ) : null}
    </div>
  );
}
