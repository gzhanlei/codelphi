import { evidenceItems, evidenceKind, evidenceLabel } from "@/lib/evidence";

const kindLabels: Record<"test" | "document", string> = { test: "[测试]", document: "[文档]" };

function EvidenceLink({ item, index }: { item: ReturnType<typeof evidenceItems>[number]; index: number }) {
  const label = evidenceLabel(item);
  const kind = evidenceKind(item.path);
  const marker = kindLabels[kind as "test" | "document"];
  return item.url
    ? <a href={item.url} target="_blank" rel="noreferrer" key={`${item.path}-${index}`}>{marker ? <span className="evidence-kind">{marker}</span> : null}{label} ↗</a>
    : <code key={`${item.path}-${index}`}>{marker ? <span className="evidence-kind">{marker}</span> : null}{label}</code>;
}

export function EvidenceLinks({ value }: { value: unknown }) {
  const items = evidenceItems(value);
  if (items.length === 0) return null;
  return (
    <div className="evidence-list">
      {items.map((item, index) => <EvidenceLink item={item} index={index} key={`${item.path}-${index}`} />)}
    </div>
  );
}
