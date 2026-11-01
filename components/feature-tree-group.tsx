import Link from "next/link";
import type { FeatureTreeItem } from "@/lib/feature-tree";

function linkClass(selected: boolean) {
  return selected ? "selected" : "";
}

export function FeatureTreeGroup({ feature, selectedId }: { feature: FeatureTreeItem; selectedId?: number }) {
  return (
    <div className="feature-tree-group">
      <details open>
        <summary><Link className={linkClass(selectedId === feature.id)} href={`?view=spec&feature=${feature.id}`}>{feature.name}<span>{feature.children.length}</span></Link></summary>
        <div className="feature-tree-children">
          {feature.children.map((child) => <Link className={linkClass(selectedId === child.id)} href={`?view=spec&feature=${child.id}`} key={child.id}>{child.name}</Link>)}
        </div>
      </details>
    </div>
  );
}
