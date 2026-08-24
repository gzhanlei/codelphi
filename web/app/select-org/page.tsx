import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Button, Shell } from "@/components/ui";
import { gw, type Me } from "@/lib/gateway";
import { COOKIE_ORG, cookieOpts } from "@/lib/session";

async function bindOrg(form: FormData) {
  "use server";
  const orgId = String(form.get("org_id") || "");
  if (!orgId) return;
  (await cookies()).set(COOKIE_ORG, orgId, cookieOpts());
  redirect("/");
}

export default async function SelectOrgPage() {
  let me: Me;
  try {
    me = await gw<Me>("/v1/me");
  } catch {
    redirect("/login");
  }
  const active = me.memberships.filter((m) => m.status === "active");
  if (active.length <= 1) redirect("/");

  return (
    <Shell>
      <h1 className="font-serif text-2xl">选择身份</h1>
      <p className="mt-2 text-muted">你在多个机构有席位，请选择本次以哪个身份进入。</p>
      <ul className="mt-8 space-y-3">
        {active.map((m) => (
          <li key={m.org_id} className="border border-line bg-card px-4 py-3">
            <form action={bindOrg}>
              <input type="hidden" name="org_id" value={m.org_id} />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium">{m.org_name}</div>
                  <div className="text-sm text-muted">{m.role}</div>
                </div>
                <Button type="submit">进入</Button>
              </div>
            </form>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
