"use client";

import { useState } from "react";
import type { SpecAnswer } from "@/lib/spec-ask";
import { featureHref } from "@/lib/spec-editor-ui";

/**
 * B2.1 检索式问答：一次问句 → 一组规格原文卡片。
 * 没有对话历史、没有模型新写的文字；未命中明确声明「规格未覆盖」。
 * 显式提交而非逐字触发：一次回答最多会跑 8 组检索，不能绑在每次按键上。
 */
export function SpecAsk({ slug, productBase }: { slug: string; productBase: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<SpecAnswer | null>(null);
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
      setAnswer(await response.json() as SpecAnswer);
    } catch {
      // 匿名 demo 下接口可能不可用：给出可见失败态，而不是静默无结果。
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
      {answer ? (
        <div className="spec-ask-answer">
          <p className={answer.status === "uncovered" ? "spec-ask-uncovered" : "spec-ask-notice"}>{answer.notice}</p>
          {answer.status === "matched" ? (
            <div className="spec-ask-cards">
              {answer.features.map((feature) => (
                <a className="spec-search-hit" href={`${productBase}${featureHref(feature.id)}`} key={`f${feature.id}`}>
                  <span className="spec-search-kind">功能</span><strong>{feature.name}</strong><p>{feature.summary}</p>
                </a>
              ))}
              {answer.scenarios.map((scenario) => (
                <a className="spec-search-hit" href={`${productBase}${featureHref(scenario.featureId)}`} key={`s${scenario.id}`}>
                  <span className="spec-search-kind">场景</span><strong>{scenario.featureName} · {scenario.reference}</strong><p>{scenario.context} → {scenario.action} → {scenario.outcome}</p>
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
