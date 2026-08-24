import { redirect } from "next/navigation";
import { Button, Shell } from "@/components/ui";
import { gw, type Me, type PresetCopy } from "@/lib/gateway";
import { getOrgId } from "@/lib/session";

export default async function NewLessonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await gw<Me>("/v1/me");
  const orgId = await getOrgId();
  const org = me.memberships.find((m) => m.org_id === orgId);
  if (org?.role === "viewer") redirect(`/projects/${id}`);

  const detail = await gw<{
    project: { id: string; title: string };
    preset?: { copy: PresetCopy };
  }>(`/v1/projects/${id}`);
  const copy = detail.preset?.copy;

  async function create(form: FormData) {
    "use server";
    const projectId = String(form.get("project_id") || "").trim();
    const title = String(form.get("title") || "").trim();
    if (!title || !projectId) return;
    const created = await gw<{ id: string }>(`/v1/projects/${projectId}/lessons`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    redirect(`/projects/${projectId}/lessons/${created.id}`);
  }

  return (
    <Shell orgName={org?.org_name}>
      <p className="text-sm text-muted">
        <a href={`/projects/${id}`} className="hover:underline">
          {detail.project.title}
        </a>
        <span className="mx-2">/</span>
      </p>
      <h1 className="mt-2 font-serif text-2xl">{copy?.lesson_title || "新建一课"}</h1>
      <form action={create} className="mt-8 max-w-lg space-y-5">
        <input type="hidden" name="project_id" value={id} />
        <label className="block">
          <span className="text-sm text-muted">{copy?.lesson_title_label || "课名"}</span>
          <input
            name="title"
            required
            placeholder={copy?.lesson_title_hint || "例如：第 3 章 导数"}
            className="mt-1 w-full border border-line bg-card px-3 py-2 outline-none focus:border-ink"
          />
        </label>
        <Button type="submit">创建</Button>
      </form>
    </Shell>
  );
}
