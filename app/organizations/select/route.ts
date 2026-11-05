import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/session";
import { setCurrentOrganization } from "@/lib/organizations";
import { appUrl } from "@/lib/env";

export async function POST(request: Request) {
  const user = await requireSessionUser();
  const form = await request.formData();
  const slug = String(form.get("organization") ?? "").trim();
  try {
    await setCurrentOrganization(user, slug);
    return NextResponse.redirect(new URL("/", appUrl()), { status: 303 });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
}
