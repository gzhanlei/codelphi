import { NextRequest, NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/session";
import { routeEntityId } from "@/lib/editor-route";
import { getArchitectureDocument } from "@/lib/architecture-store";
import { architectureArtifactResponse } from "@/lib/artifact-response";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await requireSessionUser();
  const { id } = await context.params;
  const document = await getArchitectureDocument(routeEntityId(id));
  if (!document) return NextResponse.json({ error: "架构文档不存在" }, { status: 404 });
  return architectureArtifactResponse(document);
}
