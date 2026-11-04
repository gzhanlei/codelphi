import { NextRequest, NextResponse } from "next/server";
import { requireOrganization } from "@/lib/organizations";
import { deleteRepositoryConnection } from "@/lib/repository-connections";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { id } = await context.params;
  const result = await deleteRepositoryConnection(Number(id), organization.id);
  return NextResponse.json(result);
}
