import { NextRequest, NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";
import { getProductDetails } from "@/lib/product-details";
import { createFeedbackReport } from "@/lib/feedback";

export async function POST(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user);
  const { slug } = await context.params;
  const details = await getProductDetails(slug, organization.id);
  if (!details) return NextResponse.json({ error: "product_not_found" }, { status: 404 });
  try {
    const id = await createFeedbackReport({ user, organization, details });
    return NextResponse.json({ id, status: "recorded" }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "feedback_failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
