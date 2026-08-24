import Link from "next/link";
import { Button, Shell } from "@/components/ui";
import { gw, type CourseLesson, type Me, type PresetCopy } from "@/lib/gateway";
import { getOrgId } from "@/lib/session";

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await gw<Me>("/v1/me");
  const orgId = await getOrgId();
  const org = me.memberships.find((m) => m.org_id === orgId);
  const detail = await gw<{
    project: { id: string; title: string };
    preset?: { copy: PresetCopy };
    lessons?: CourseLesson[];
  }>(`/v1/projects/${id}`);
  const copy = detail.preset?.copy;
  const lessons = detail.lessons || [];
  const canWrite = org?.role !== "viewer";

  return (
    <Shell orgName={org?.org_name}>
      <p className="text-sm text-muted">
        <a href="/" className="hover:underline">
          {copy?.list_title || "我的课程"}
        </a>
        <span className="mx-2">/</span>
      </p>
      <div className="mt-2 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl">{detail.project.title}</h1>
          <p className="mt-1 text-sm text-muted">{copy?.list_hint || "一套课程，每一课各自材料与套件。"}</p>
        </div>
        {canWrite ? (
          <Button href={`/projects/${id}/lessons/new`}>{copy?.lesson_cta || "新建一课"}</Button>
        ) : null}
      </div>
      {lessons.length === 0 ? (
        <p className="mt-16 text-center text-muted">{copy?.empty_lessons || "这套课程还没有课。"}</p>
      ) : (
        <ul className="mt-8 divide-y divide-line border-y border-line">
          {lessons.map((cl) => (
            <li key={cl.id}>
              <Link
                href={`/projects/${id}/lessons/${cl.id}`}
                className="flex items-baseline justify-between py-4 hover:bg-line/20"
              >
                <span className="font-serif text-lg">{cl.title}</span>
                <span className="text-xs text-muted">{packageLabel(cl.package_status) || "打开"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function packageLabel(status?: string) {
  switch (status) {
    case "building":
      return "生成中";
    case "ready":
      return "已出套件";
    case "partial":
      return "缺件";
    case "draft":
      return "草稿";
    default:
      return "";
  }
}
