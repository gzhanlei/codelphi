import { NextRequest, NextResponse } from "next/server";
import { requireOrganization } from "@/lib/organizations";
import { productRemovalError, removeProduct } from "@/lib/product-removal";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function DELETE(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  try {
    const { slug } = await context.params;
    await removeProduct(slug, organization.id);
    return NextResponse.json({ status: "deleted" });
  } catch (error) {
    const { status, message } = productRemovalError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
