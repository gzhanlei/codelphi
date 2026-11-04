import { NextRequest, NextResponse } from "next/server";
import { requireOrganization } from "@/lib/organizations";
import { createRepositoryConnection, repositoryConnectionError } from "@/lib/repository-connections";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  try {
    const connection = await createRepositoryConnection(organization.id, await request.json());
    return NextResponse.json(connection, { status: 201 });
  } catch (error) {
    const { status, message } = repositoryConnectionError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
