import { NextRequest, NextResponse } from "next/server";
import { requireOrganization } from "./organizations";
import { requireSessionUser } from "./session";

interface ConnectionCheckResult {
  status: number;
  body: object;
}

type ConnectionCheck = (id: number, organizationId: number) => Promise<ConnectionCheckResult>;

export function createConnectionCheckHandler(check: ConnectionCheck) {
  return async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const user = await requireSessionUser();
    const organization = await requireOrganization(user, "editor");
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "连接 ID 无效" }, { status: 404 });
    const result = await check(id, organization.id);
    return NextResponse.json(result.body, { status: result.status });
  };
}
