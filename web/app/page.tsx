import Link from "next/link";
import { redirect } from "next/navigation";
import { Button, Shell } from "@/components/ui";
import { GatewayError, gw, type Me, type PresetsResponse, type Project } from "@/lib/gateway";
import { getOrgId } from "@/lib/session";

export default async function HomePage() {
  let me: Me;
  try {
    me = await gw<Me>("/v1/me");
  } catch (e) {
    if (e instanceof GatewayError && e.status === 401) redirect("/login");
    throw e;
  }
  const active = me.memberships.filter((m) => m.status === "active");
  if (active.length === 0) {
    return (
      <Shell>
        <h1 className="font-serif text-2xl">尚未绑定机构</h1>
        <p className="mt-3 text-muted">请联系本机构管理员发送邀请。</p>
        <p className="mt-8 text-sm text-muted">开通时需要这个 Chandler sub：</p>
        <p className="mt-2 break-all font-mono text-sm">{me.sub}</p>
      </Shell>
    );
  }
  const orgId = await getOrgId();
  if (active.length > 1 && !orgId) {
    redirect("/select-org");
  }
  const org = active.find((m) => m.org_id === orgId) || active[0];
  let projects: Project[] = [];
  try {
    const data = await gw<{ projects: Project[] }>("/v1/projects", { orgId: org.org_id });
    projects = data.projects || [];
  } catch (e) {
    if (e instanceof GatewayError && (e.code === "org_unspecified" || e.code === "org_mismatch")) {
      redirect("/select-org");
    }
    throw e;
  }

  const catalog = await gw<PresetsResponse>("/v1/presets", { orgId: org.org_id });
  const copy = catalog.presets[0]?.copy;
  const createLabel = catalog.presets.length === 1 ? copy?.create_cta || "新建" : "新建";

  return (
    <Shell orgName={org.org_name}>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-serif text-2xl">{copy?.list_title || "我的项目"}</h1>
          <p className="mt-1 text-sm text-muted">{copy?.list_hint || "一个项目一份材料、一套产物。"}</p>
        </div>
        {org.role !== "viewer" ? <Button href="/projects/new">{createLabel}</Button> : null}
      </div>
      {projects.length === 0 ? (
        <p className="mt-16 text-center text-muted">{copy?.empty_list || "还没有项目。点右上角建第一个。"}</p>
      ) : (
        <ul className="mt-8 divide-y divide-line border-y border-line">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="flex items-baseline justify-between py-4 hover:bg-line/20">
                <span className="font-serif text-lg">{p.title}</span>
                <span className="text-xs text-muted">打开</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
