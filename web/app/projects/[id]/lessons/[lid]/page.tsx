import { Shell } from "@/components/ui";
import { gw, type Me, type PresetCopy } from "@/lib/gateway";
import { getOrgId } from "@/lib/session";
import { LessonWorkbench } from "./workbench";

export default async function LessonPage({ params }: { params: Promise<{ id: string; lid: string }> }) {
  const { id, lid } = await params;
  const me = await gw<Me>("/v1/me");
  const orgId = await getOrgId();
  const org = me.memberships.find((m) => m.org_id === orgId);
  const detail = await gw<{
    lesson: { id: string; title: string; project_id: string };
    project: { id: string; title: string };
  }>(`/v1/projects/${id}/lessons/${lid}`);
  const course = await gw<{
    preset?: { copy: PresetCopy };
  }>(`/v1/projects/${id}`);

  return (
    <Shell orgName={org?.org_name}>
      <p className="text-sm text-muted">
        <a href="/" className="hover:underline">
          {course.preset?.copy.list_title || "我的课程"}
        </a>
        <span className="mx-2">/</span>
        <a href={`/projects/${id}`} className="hover:underline">
          {detail.project.title}
        </a>
        <span className="mx-2">/</span>
      </p>
      <h1 className="mt-2 font-serif text-2xl">{detail.lesson.title}</h1>
      <LessonWorkbench
        projectId={id}
        lessonId={lid}
        canWrite={org?.role !== "viewer"}
        copy={course.preset?.copy}
      />
    </Shell>
  );
}
