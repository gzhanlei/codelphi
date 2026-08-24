"use client";

import { useCallback, useEffect, useState } from "react";
import { Banner, Button } from "@/components/ui";
import type { APIError, Lesson, PackageSnap, PresetCopy } from "@/lib/gateway";

const fallbackLabels: Record<string, string> = {
  design: "课程设计",
  outline: "教学大纲",
  ppt: "PPT",
  script: "讲稿",
};

export function ProjectWorkbench({
  projectId,
  canWrite,
  initialPackageId,
  copy,
}: {
  projectId: string;
  canWrite: boolean;
  initialPackageId?: string;
  copy?: PresetCopy;
}) {
  const [pkg, setPkg] = useState<PackageSnap | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [err, setErr] = useState<APIError | null>(null);

  const load = useCallback(
    async (packageId: string) => {
      const res = await fetch(`/api/gw/v1/packages/${packageId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || { code: "http_error", message: "读取套件失败" });
        return;
      }
      setPkg(data);
      setErr(data.error || null);
    },
    [],
  );

  useEffect(() => {
    if (initialPackageId) void load(initialPackageId);
  }, [initialPackageId, load]);

  useEffect(() => {
    const status = pkg?.lesson_status;
    if (!pkg?.id || !status) return;
    if (status !== "running" && status !== "queued") return;
    const t = setInterval(() => void load(pkg.id), 1500);
    return () => clearInterval(t);
  }, [pkg?.id, pkg?.lesson_status, load]);

  async function upload(file: File) {
    const fd = new FormData();
    fd.set("kind", "text");
    fd.set("file", file);
    setBusy(true);
    setUploadMsg("");
    const res = await fetch(`/api/gw/v1/projects/${projectId}/materials`, { method: "POST", body: fd });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json();
      setErr(data.error || { code: "upload", message: "上传失败" });
      return;
    }
    setUploadMsg(`已上传 ${file.name}（P0 仅文本）`);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/gw/v1/projects/${projectId}/submit`, {
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
    await load(data.package_id);
  }

  async function confirm() {
    if (!pkg?.lesson_job_id) return;
    setBusy(true);
    const res = await fetch(`/api/gw/v1/lessons/${pkg.lesson_job_id}/confirm`, { method: "POST" });
    const data = (await res.json()) as Lesson & { error?: APIError };
    setBusy(false);
    if (!res.ok) {
      setErr(data.error || { code: "confirm", message: "确认失败" });
      return;
    }
    await load(pkg.id);
  }

  const lesson = pkg?.lesson_status;

  return (
    <div className="mt-8 space-y-8">
      {err ? <Banner code={err.code} message={err.message} hint={err.admin_hint} /> : null}

      {canWrite && (!pkg || lesson === "failed") ? (
        <section className="space-y-4 border border-line bg-card p-5">
          <h2 className="font-serif text-lg">材料与说明</h2>
          <p className="text-sm text-muted">P0 只收文本材料。pdf/docx 提取稍后做。</p>
          <input
            type="file"
            accept=".txt,text/plain"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          {uploadMsg ? <p className="text-sm text-muted">{uploadMsg}</p> : null}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="补充说明（选填）。当前数字课试点可写学时、专业、风格"
            className="h-24 w-full border border-line bg-paper px-3 py-2 text-sm outline-none focus:border-ink"
          />
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "提交中…" : copy?.submit_cta || "做课"}
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

          {lesson === "awaiting_confirm" && canWrite ? (
            <div className="border border-line bg-card p-5">
              <p className="text-sm">{copy?.confirm_hint || "看过之后点确认，才会继续生成。等待期间不扣配额。"}</p>
              <div className="mt-4">
                <Button onClick={() => void confirm()} disabled={busy}>
                  {copy?.confirm_cta || "通过，继续"}
                </Button>
              </div>
            </div>
          ) : null}

          {lesson === "running" || lesson === "queued" ? (
            <p className="text-sm text-muted">正在生成，可离开此页，进度会保留。</p>
          ) : null}

          <ul className="space-y-3">
            {pkg.artifacts.map((a) => (
              <li key={a.kind} className="border border-line bg-card px-4 py-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-serif">{copy?.artifact_labels?.[a.kind] || fallbackLabels[a.kind] || a.kind}</span>
                  {a.current?.url ? (
                    <a href={mediaHref(a.current.url)} className="text-sm text-seal hover:underline" target="_blank" rel="noreferrer">
                      预览 / 下载 · v{a.current.version}
                    </a>
                  ) : (
                    <span className="text-sm text-muted">尚未就绪</span>
                  )}
                </div>
                {a.versions.length > 1 ? (
                  <p className="mt-2 text-xs text-muted">
                    历史版本：
                    {a.versions.map((v) => (
                      <a key={v.id} href={v.url ? mediaHref(v.url) : "#"} className="ml-2 hover:underline">
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
