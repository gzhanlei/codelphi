"use client";

import { useEffect, useRef, useState } from "react";
import type { SpecSearchResult } from "@/lib/spec-search";
import { featureHref } from "@/lib/spec-editor-ui";

/** M3 产品内搜索：功能名/摘要、场景四段文本与证据路径，结果直达对应功能视图。 */
export function SpecSearch({ slug }: { slug: string }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SpecSearchResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const requestId = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 结果面板是绝对定位下拉：点击面板外或按 Escape 时收起，否则会一直盖住下方内容（影响面查询栏）。
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setResult(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setResult(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResult(null);
      setFailed(false);
      return;
    }
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setPending(true);
      setFailed(false);
      try {
        const response = await fetch(`/api/products/${slug}/spec/search?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`search failed: ${response.status}`);
        const payload = await response.json() as SpecSearchResult;
        if (requestId.current === id) setResult(payload);
      } catch {
        // 匿名 demo 下接口可能不可用：给出可见失败态，而不是静默无结果。
        if (requestId.current === id) setFailed(true);
      } finally {
        if (requestId.current === id) setPending(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, slug]);

  const empty = result && result.features.length === 0 && result.scenarios.length === 0;
  return (
    <div className="spec-search" ref={containerRef}>
      <input
        aria-label="搜索规格"
        type="search"
        placeholder="搜索功能、场景或证据路径…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setResult(null); }}
      />
      {pending ? <span className="spec-search-hint">搜索中…</span> : null}
      {failed ? <p className="spec-search-hint" role="alert">搜索暂时不可用，请稍后重试。</p> : null}
      {result ? (
        <div className="spec-search-results">
          {result.features.map((feature) => (
            <a className="spec-search-hit" href={`/products/${slug}${featureHref(feature.id)}`} key={`f${feature.id}`}>
              <span className="spec-search-kind">功能</span><strong>{feature.name}</strong><p>{feature.summary}</p>
            </a>
          ))}
          {result.scenarios.map((scenario) => (
            <a className="spec-search-hit" href={`/products/${slug}${featureHref(scenario.featureId)}`} key={`s${scenario.id}`}>
              <span className="spec-search-kind">场景</span><strong>{scenario.featureName} · {scenario.reference}</strong><p>{scenario.context} → {scenario.action} → {scenario.outcome}</p>
            </a>
          ))}
          {empty ? <p className="spec-search-hint">没有匹配的功能或场景。</p> : null}
        </div>
      ) : null}
    </div>
  );
}
