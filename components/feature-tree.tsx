"use client";

import { useState } from "react";
import { FeatureTreeGroup } from "./feature-tree-group";
import { featureMatches } from "@/lib/spec-editor-ui";
import type { FeatureTreeItem } from "@/lib/feature-tree";

export function FeatureTree({ slug, items, selectedId, onCreateRoot }: { slug: string; items: FeatureTreeItem[]; selectedId?: number; onCreateRoot: () => void }) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  return (
    <aside className="feature-tree">
      <div className="feature-tree-tools"><input aria-label="筛选功能" placeholder="筛选功能" value={query} onChange={(event) => setQuery(event.target.value)} /><button className="text-button" type="button" onClick={onCreateRoot}>＋ 新功能</button></div>
      <nav aria-label="功能树">
        {items.map((feature) => {
          if (!featureMatches(feature, normalized)) return null;
          return <FeatureTreeGroup feature={feature} selectedId={selectedId} key={feature.id} />;
        })}
      </nav>
    </aside>
  );
}
