"use client";

import { useCallback, useEffect, useState } from "react";
import { Banner, Button } from "@/components/ui";
import type { APIError, Lesson, LessonMaterial, PackageSnap, PresetCopy } from "@/lib/gateway";

const fallbackLabels: Record<string, string> = {
  design: "课程设计",
  outline: "教学大纲",
  ppt: "PPT",
  script: "讲稿",
};

const acceptTypes = ".pdf,.docx,.md,.txt,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain";
const maxMaterials = 5;

export function LessonWorkbench({
  projectId,
  lessonId,
  canWrite,
  copy,
}: {
  projectId: string;
  lessonId: string;
  canWrite: boolean;
  copy?: PresetCopy;
}) {
  const [pkg, setPkg] = useState<PackageSnap | null>(null);
  const [materials, setMaterials] = useState<LessonMaterial[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [err, setErr] = useState<APIError | null>(null);

  const loadPackage = useCallback(async (packageId: string) => {
    const res = await fetch(`/api/gw/v1/packages/${packageId}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setErr(data.error || { code: "http_error", message: "读取套件失败" });
      return;
    }
    setPkg(data);
    setErr(data.error || null);
  }, []);

  const loadLesson = useCallback(async () => {
    const res = await fetch(`/api/gw/v1/projects/${projectId}/lessons/${lessonId}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) {
      setErr(data.error || { code: "http_error", message: "读取课失败" });
      return;
    }
    setMaterials(data.materials || []);
    if (data.package_id) {
      await loadPackage(data.package_id);
    }
  }, [projectId, lessonId, loadPackage]);

  useEffect(() => {
    void loadLesson();
  }, [loadLesson]);

  useEffect(() => {
    const status = pkg?.lesson_status;
    if (!pkg?.id || !status) return;
    if (status !== "running" && status !== "queued") return;
    const t = setInterval(() => void loadPackage(pkg.id), 1500);
    return () => clearInterval(t);
  }, [pkg?.id, pkg?.lesson_status, loadPackage]);

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remaining = maxMaterials - materials.length;
    if (remaining <= 0) {
      setErr({ code: "too_many_materials", message: "每课最多 5 份材料" });
      return;
    }
    const picked = Array.from(files).slice(0, remaining);
    setBusy(true);
    setUploadMsg("");
    setErr(null);
    const names: string[] = [];
    for (const file of picked) {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch(`/api/gw/v1/projects/${projectId}/lessons/${lessonId}/materials`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const data = await res.json();
        setBusy(false);
        setErr(data.error || { code: "upload", message: "上传失败" });
        await loadLesson();
        return;
      }
      names.push(file.name);
    }
    setBusy(false);
    setUploadMsg(`已上传 ${names.join("、")}`);
    await loadLesson();
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/gw/v1/projects/${projectId}/lessons/${lessonId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    const data = (await res.json()) as Lesson & { error?: APIError };
    setBusy(false);
    if (!res.ok) {
      setErr(data.error || { code: "submit", message: "提交失败" });
      return;
    }
    await loadPackage(data.package_id);
  }

  async function importPPT(files: FileList | null) {
    if (!files || files.length === 0 || !pkg?.id) return;
    const file = files[0];
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.set("file", file);
    const res = await fetch(`/api/gw/v1/packages/${pkg.id}/artifacts/ppt`, { method: "POST", body: fd });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(data.error || { code: "import", message: "导回失败" });
      return;
    }
    await loadPackage(pkg.id);
  }

  const lesson = pkg?.lesson_status;
  const canUpload = canWrite && (!pkg || lesson === "failed");
  const slots = maxMaterials - materials.length;

  return (
    <div className="mt-8 space-y-8">
      {err ? <Banner code={err.code} message={err.message} hint={err.admin_hint} /> : null}

      {canUpload ? (
        <section className="space-y-4 border border-line bg-card p-5">
          <h2 className="font-serif text-lg">材料与说明</h2>
          <p className="text-sm text-muted">
            {copy?.materials_hint || "每课最多 5 份。支持 PDF、Word（.docx）、Markdown、纯文本。"}
          </p>
          {materials.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {materials.map((m) => (
                <li key={m.id} className="text-muted">
                  {m.filename || m.id}
                  <span className="ml-2 text-xs">{m.kind}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {slots > 0 ? (
            <input
              type="file"
              multiple
              accept={acceptTypes}
              disabled={busy}
              onChange={(e) => {
                const files = e.target.files;
                void uploadFiles(files);
                e.target.value = "";
              }}
            />
          ) : (
            <p className="text-sm text-muted">已满 5 份，不能再传。</p>
          )}
          {uploadMsg ? <p className="text-sm text-muted">{uploadMsg}</p> : null}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="补充说明（选填）。可写学时、专业、风格"
            className="h-24 w-full border border-line bg-paper px-3 py-2 text-sm outline-none focus:border-ink"
          />
          <Button onClick={() => void submit()} disabled={busy || materials.length === 0}>
            {busy ? "提交中…" : copy?.submit_cta || "做课件"}
          </Button>
        </section>
      ) : null}

      {pkg ? (
        <section className="space-y-4">
          <h2 className="font-serif text-lg">套件进度</h2>
          <ol className="space-y-2 text-sm">
            {(pkg.steps || []).map((s) => (
              <li key={s.id} className="flex justify-between border-b border-line/70 py-2">
                <span>{copy?.artifact_labels?.[s.capability] || fallbackLabels[s.capability] || s.capability}</span>
                <span className="text-muted">{statusLabel(s.status)}</span>
              </li>
            ))}
            {(!pkg.steps || pkg.steps.length === 0) && (
              <li className="text-muted">{statusLabel(lesson || pkg.status)}</li>
            )}
          </ol>

          {lesson === "running" || lesson === "queued" ? (
            <p className="text-sm text-muted">正在生成，可离开此页，进度会保留。</p>
          ) : null}

          <ul className="space-y-3">
            {(pkg.artifacts || []).map((a) => (
              <li key={a.kind} className="border border-line bg-card px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-serif">{copy?.artifact_labels?.[a.kind] || fallbackLabels[a.kind] || a.kind}</span>
                  <div className="flex items-center gap-3">
                    {a.kind === "ppt" && canWrite && a.current?.url ? (
                      <label className={`text-sm text-seal ${busy ? "pointer-events-none opacity-50" : "cursor-pointer hover:underline"}`}>
                        导回本地修改
                        <input
                          type="file"
                          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                          className="hidden"
                          disabled={busy}
                          onChange={(e) => {
                            const files = e.target.files;
                            void importPPT(files);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    ) : null}
                    {a.current?.url ? (
                      <a href={mediaHref(a.current.url)} className="text-sm text-seal hover:underline" {...fileLinkProps(a.current.url)}>
                        预览 / 下载 · v{a.current.version}
                      </a>
                    ) : (
                      <span className="text-sm text-muted">尚未就绪</span>
                    )}
                  </div>
                </div>
                {(a.versions || []).length > 1 ? (
                  <p className="mt-2 text-xs text-muted">
                    历史版本：
                    {(a.versions || []).map((v) => (
                      <a key={v.id} href={v.url ? mediaHref(v.url) : "#"} className="ml-2 hover:underline" {...(v.url ? fileLinkProps(v.url) : {})}>
                        v{v.version}
                      </a>
                    ))}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function statusLabel(s: string) {
  switch (s) {
    case "queued":
      return "排队";
    case "running":
      return "生成中";
    case "awaiting_confirm":
      return "待确认";
    case "succeeded":
    case "ready":
      return "完成";
    case "failed":
    case "partial":
      return "失败 / 缺件";
    default:
      return s;
  }
}

function mediaHref(url: string) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return url;
}

function fileLinkProps(url: string): { download: string } | { target: "_blank"; rel: "noreferrer" } {
  const name = mediaFileName(url);
  if (name.endsWith(".pptx") || name.endsWith(".docx")) {
    return { download: name };
  }
  return { target: "_blank", rel: "noreferrer" };
}

function mediaFileName(url: string): string {
  try {
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];
    const seg = path.split("/").filter(Boolean).pop() || "download";
    return decodeURIComponent(seg);
  } catch {
    return "download";
  }
}
