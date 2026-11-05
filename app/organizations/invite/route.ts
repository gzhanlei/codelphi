import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/session";
import { inviteOrganizationMember } from "@/lib/organization-invitations";
import { inviteProductMember } from "@/lib/product-members";
import { currentOrganization } from "@/lib/organizations";
import { getDb } from "@/lib/db";
import { appUrl } from "@/lib/env";

export async function POST(request: Request) {
  const user = await requireSessionUser();
  const organization = await currentOrganization(user);
  if (organization.role !== "owner") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const form = await request.formData();
  const input = { email: String(form.get("email") ?? ""), role: String(form.get("role") ?? "") };
  try {
    const productSlug = String(form.get("product") ?? "").trim();
    let result;
    if (productSlug) {
      const [rows] = await getDb().execute(
        "SELECT id, slug, name FROM products WHERE slug = ? AND organization_id = ? LIMIT 1",
        [productSlug, organization.id],
      );
      const product = (rows as Array<{ id: number; slug: string; name: string }>)[0];
      if (!product) return NextResponse.json({ error: "product_not_found" }, { status: 404 });
      result = await inviteProductMember(user, organization, product, input, (sql, parameters) => getDb().execute(sql, parameters));
    } else {
      result = await inviteOrganizationMember(user, input, (sql, parameters) => getDb().execute(sql, parameters), organization);
    }
    const url = new URL(`/organizations?invited=${result.status}`, appUrl());
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
