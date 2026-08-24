import { redirect } from "next/navigation";
import { Button, Shell } from "@/components/ui";
import { gw, type Me, type PresetsResponse } from "@/lib/gateway";
import { getOrgId } from "@/lib/session";

export default async function NewProjectPage() {
  const me = await gw<Me>("/v1/me");
  const orgId = await getOrgId();
  const org = me.memberships.find((m) => m.org_id === orgId);
  if (org?.role === "viewer") redirect("/");

  const catalog = await gw<PresetsResponse>("/v1/presets");
  const copy = catalog.presets[0]?.copy;
  const multi = catalog.entitled.length > 1;

  async function create(form: FormData) {
    "use server";
    const title = String(form.get("title") || "").trim();
    if (!title) return;
    const body: { title: string; preset_id?: string } = { title };
    const presetId = String(form.get("preset_id") || "").trim();
    if (presetId) body.preset_id = presetId;
    const created = await gw<{ id: string }>("/v1/projects", {
      method: "POST",
      body: JSON.stringify(body),
    });
    redirect(`/projects/${created.id}`);
  }

  return (
    <Shell orgName={org?.org_name}>
      <h1 className="font-serif text-2xl">{copy?.create_title || "新建课程"}</h1>
      <form action={create} className="mt-8 max-w-lg space-y-5">
        {multi ? (
          <fieldset className="space-y-2">
            <legend className="text-sm text-muted">选择套件</legend>
            {catalog.presets.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <input type="radio" name="preset_id" value={p.id} required defaultChecked={catalog.presets.length === 1} />
                {p.copy.create_cta || p.id}
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="block">
          <span className="text-sm text-muted">{copy?.title_label || "课程名"}</span>
          <input
            name="title"
            required
            placeholder={copy?.title_hint || "例如：高等数学"}
            className="mt-1 w-full border border-line bg-card px-3 py-2 outline-none focus:border-ink"
          />
        </label>
        <Button type="submit">创建</Button>
      </form>
    </Shell>
  );
}
