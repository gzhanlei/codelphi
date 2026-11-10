import Link from "next/link";
import type { FeatureTreeItem } from "@/lib/feature-tree";
import { featureHref, selectedClass } from "@/lib/spec-editor-ui";

export function FeatureTreeGroup({ feature, selectedId }: { feature: FeatureTreeItem; selectedId?: number }) {
  return (
    <div className="feature-tree-group">
      <details open>
        <summary><Link scroll={false} className={selectedClass(selectedId === feature.id)} href={featureHref(feature.id)}>{feature.name}{feature.children.length > 0 ? <span>{feature.children.length}</span> : null}</Link></summary>
        <div className="feature-tree-children">
          {feature.children.map((child) => <Link scroll={false} className={selectedClass(selectedId === child.id)} href={featureHref(child.id)} key={child.id}>{child.name}</Link>)}
        </div>
      </details>
    </div>
  );
}
