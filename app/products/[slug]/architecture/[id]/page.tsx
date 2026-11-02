import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { requireSessionUser } from "@/lib/session";
import { getArchitectureDocument } from "@/lib/architecture-store";
import { routeEntityId } from "@/lib/editor-route";

export default async function ProductArchitecturePage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const user = await requireSessionUser();
  const { slug, id } = await params;
  const document = await getArchitectureDocument(routeEntityId(id));
  if (!document || document.status !== "accepted" || document.productSlug !== slug) notFound();

  return (
    <AppShell user={user}>
      <div className="architecture-page-header">
        <Link className="back-link" href={`/products/${slug}`}>← 返回产品概览</Link>
        <div><span className="eyebrow">SYSTEM ARCHITECTURE</span><h1>{document.productName} 系统架构</h1><p>Spec v{document.specVersionId} · {document.revision.slice(0, 7)}</p></div>
      </div>
      <iframe className="architecture-frame" src={`/api/architecture/${document.id}`} title={`${document.productName} 系统架构`} sandbox="allow-scripts allow-downloads" />
    </AppShell>
  );
}
