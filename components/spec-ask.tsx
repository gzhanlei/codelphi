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
export function SpecAsk({ slug, productBase }: { slug: string; productBase: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<DecoratedSpecAnswer | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function ask() {
    const trimmed = question.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/products/${slug}/spec/ask?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`ask failed: ${response.status}`);
      setAnswer(await response.json() as DecoratedSpecAnswer);
    } catch {
      // 匿名 demo 已由 spec-read-access 放行；网络或服务端异常仍要给可见失败态，不静默无结果。
      setFailed(true);
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
      {failed ? <p className="spec-search-hint" role="alert">查询暂时不可用，请稍后重试。</p> : null}
      {answer ? <SpecAnswerView answer={answer} productBase={productBase} /> : null}
    </div>
  );
}

/** 纯展示：把一次检索答案渲染成规格原文卡片。无 hooks、无 fetch，可在 node 环境用 renderToStaticMarkup 测试。 */
export function SpecAnswerView({ answer, productBase }: { answer: DecoratedSpecAnswer; productBase: string }) {
  return (
    <div className="spec-ask-answer">
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
          {answer.scenarios.map((scenario) => (
            // 卡片不能整体包 <a>：证据里的 blob 链接也是 <a>，嵌套链接是无效 HTML。
            <div className="spec-search-hit" key={`s${scenario.id}`}>
              <span className="spec-search-kind">场景</span>
              <strong><a className="spec-ask-hit-link" href={`${productBase}${featureHref(scenario.featureId)}`}>{scenario.featureName} · {scenario.reference}</a></strong>
              <p>{scenario.context} → {scenario.action} → {scenario.outcome}</p>
              <div className="spec-ask-evidence"><EvidenceLinks value={scenario.evidence} /></div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
