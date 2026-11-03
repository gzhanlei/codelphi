import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/session";
import { inviteOrganizationMember } from "@/lib/organization-invitations";
import { currentOrganization } from "@/lib/organizations";
import { getDb } from "@/lib/db";

export async function POST(request: Request) {
  const user = await requireSessionUser();
  const organization = await currentOrganization(user);
  if (organization.role !== "owner") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const form = await request.formData();
  try {
    const result = await inviteOrganizationMember(user, { email: String(form.get("email") ?? ""), role: String(form.get("role") ?? "") }, (sql, parameters) => getDb().execute(sql, parameters), organization);
    const url = new URL(`/organizations?invited=${result.status}`, request.url);
    if (result.inviteUrl) {
      url.searchParams.set("inviteUrl", result.inviteUrl);
      url.searchParams.set("emailSent", String(result.emailSent));
    }
    return NextResponse.redirect(url, { status: 303 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "invite_failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
