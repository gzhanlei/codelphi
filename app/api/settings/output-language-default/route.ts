import { apiErrorBody } from "@/lib/api-errors";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOrganization } from "@/lib/organizations";
import { requireSessionUser } from "@/lib/session";
import { getWorkspaceOutputLanguageDefault, updateWorkspaceOutputLanguageDefault } from "@/lib/analysis-trigger";

export const runtime = "nodejs";

const schema = z.object({ language: z.enum(["zh-CN", "en"]) });

const FORBIDDEN = apiErrorBody("workspace_member_only");

/** 工作区默认输出语言：新接入的产品注册时继承（已有产品在产品设置页单独管理）。 */
export async function PATCH(request: NextRequest) {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "editor");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "输出语言无效" }, { status: 400 });

  await updateWorkspaceOutputLanguageDefault(organization.id, parsed.data.language);
  return NextResponse.json({ status: "updated", language: parsed.data.language });
}

export async function GET() {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "viewer");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }
  const language = await getWorkspaceOutputLanguageDefault(organization.id);
  return NextResponse.json({ status: "ok", language });
}
