import { NextRequest, NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getProductDetails } from "@/lib/product-details";
import { createFeedbackReport } from "@/lib/feedback";

export async function POST(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "product_not_found" }, { status: 404 });
  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) return NextResponse.json({ error: "product_not_found" }, { status: 404 });
  try {
    const id = await createFeedbackReport({ user, organization: access.organization, details });
    return NextResponse.json({ id, status: "recorded" }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "feedback_failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
