import { Shell } from "@/components/ui";
import { gw, type Me, type PresetCopy } from "@/lib/gateway";
import { getOrgId } from "@/lib/session";
import { ProjectWorkbench } from "./workbench";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await gw<Me>("/v1/me");
  const orgId = await getOrgId();
  const org = me.memberships.find((m) => m.org_id === orgId);
  const detail = await gw<{
    project: { id: string; title: string; preset_id?: string };
    preset?: { copy: PresetCopy };
    package_id?: string;
    package_status?: string;
    lesson_job_id?: string;
  }>(`/v1/projects/${id}`);

  return (
    <Shell orgName={org?.org_name}>
      <p className="text-sm text-muted">
        <a href="/" className="hover:underline">
          {detail.preset?.copy.list_title || "我的项目"}
        </a>
        <span className="mx-2">/</span>
      </p>
      <h1 className="mt-2 font-serif text-2xl">{detail.project.title}</h1>
      <ProjectWorkbench
        projectId={id}
        canWrite={org?.role !== "viewer"}
        initialPackageId={detail.package_id}
        copy={detail.preset?.copy}
      />
    </Shell>
  );
}
