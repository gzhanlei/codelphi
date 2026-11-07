"use client";

import { useEffect, useRef, useState } from "react";
import type { SpecSearchResult } from "@/lib/spec-search";
import { featureHref } from "@/lib/spec-editor-ui";

/** M3 产品内搜索：功能名/摘要、场景四段文本与证据路径，结果直达对应功能视图。 */
export function SpecSearch({ slug }: { slug: string }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SpecSearchResult | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResult(null);
      return;
    }
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setPending(true);
      try {
        const response = await fetch(`/api/products/${slug}/spec/search?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
        if (response.ok && requestId.current === id) setResult(await response.json() as SpecSearchResult);
      } finally {
        if (requestId.current === id) setPending(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, slug]);

  const empty = result && result.features.length === 0 && result.scenarios.length === 0;
  return (
    <div className="spec-search">
      <input
        aria-label="搜索规格"
        type="search"
        placeholder="搜索功能、场景或证据路径…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {pending ? <span className="spec-search-hint">搜索中…</span> : null}
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
