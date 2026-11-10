"use client";

import { useEffect, useState } from "react";
import type { FeatureConnection } from "@/lib/feature-connections";
import { errorMessage } from "@/lib/error-message";

/** 功能连接（B3 确定性层）：共享证据文件面；每条带依据，可点开核查。LLM 推断层未启用。 */
export function FeatureConnectionsPanel({ slug, featureId }: { slug: string; featureId: number }) {
  const [connections, setConnections] = useState<FeatureConnection[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/products/${slug}/features/${featureId}/connections`, { cache: "no-store" });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "加载连接失败");
        if (!cancelled) setConnections((await response.json() as { connections: FeatureConnection[] }).connections);
      } catch (cause: unknown) {
        if (!cancelled) setError(errorMessage(cause, "加载连接失败"));
      }
    })();
    return () => { cancelled = true; };
  }, [slug, featureId]);

  if (error) return <p className="overview-note" role="alert">功能连接加载失败：{error}</p>;
  if (connections === null || connections.length === 0) return null;

  return (
    <details className="feature-connections">
      <summary>关联功能 · {connections.length} 个（共享证据文件面）</summary>
      {connections.map((connection) => (
        <div className="feature-connection" key={connection.targetFeatureId}>
          <strong>↔ {connection.targetFeatureName}</strong>
          {connection.sharedFiles.map((file) => (
            <p className="feature-connection-file" key={file.path}>
              <code>{file.path}</code>
              <span className="implementation-lines">本功能 {file.sourceScenarios.join("、")} ↔ {connection.targetFeatureName} {file.targetScenarios.join("、")}</span>
            </p>
          ))}
        </div>
      ))}
      <p className="overview-note">连接依据 = 共享实现文件（确定性推断）；改这些文件可能同时影响两侧行为。语义级依赖（调用/触发）不由本层宣称。</p>
    </details>
  );
}
