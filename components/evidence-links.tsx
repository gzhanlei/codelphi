import { evidenceItems, evidenceLabel } from "@/lib/evidence";

function EvidenceLink({ item, index }: { item: ReturnType<typeof evidenceItems>[number]; index: number }) {
  const label = evidenceLabel(item);
  return item.url
    ? <a href={item.url} target="_blank" rel="noreferrer" key={`${item.path}-${index}`}>{label} ↗</a>
    : <code key={`${item.path}-${index}`}>{label}</code>;
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
