"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IntroSlideDraft } from "@/lib/intro-material";
import { errorMessage } from "@/lib/error-message";
import {
  generateIntroMaterial,
  loadIntroMaterial,
  pollPptJob,
  savePositioning,
  startPptJob,
  type IntroMaterialState,
  type IntroPositioningView,
} from "@/lib/intro-material-client";
import { useDemoGuard } from "./demo-mode";

const TERMINAL = new Set(["COMPLETED", "FAILED"]);

function PositioningFields({ initial, onSave }: { initial: IntroPositioningView | null; onSave: (value: IntroPositioningView) => Promise<void> }) {
  const [audience, setAudience] = useState(initial?.audience ?? "");
  const [differentiation, setDifferentiation] = useState(initial?.differentiation ?? "");
  const [tone, setTone] = useState(initial?.tone ?? "");
  useEffect(() => {
    setAudience(initial?.audience ?? "");
    setDifferentiation(initial?.differentiation ?? "");
    setTone(initial?.tone ?? "");
  }, [initial]);
  return (
    <div className="intro-positioning">
      <label>受众<textarea maxLength={200} value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="给谁看，例如：景区商户 / 私域运营" /></label>
      <label>差异化主张（人工主张，生成时只逐字引用）<textarea maxLength={500} value={differentiation} onChange={(event) => setDifferentiation(event.target.value)} placeholder="为什么选你而不是替代品，2-3 条" /></label>
      <label>语气<input maxLength={100} value={tone} onChange={(event) => setTone(event.target.value)} placeholder="例如：克制、不夸大" /></label>
      <button className="secondary-button" type="button" onClick={() => void onSave({ audience, differentiation, tone })}>保存定位</button>
    </div>
  );
}

function SlideList({ slides }: { slides: IntroSlideDraft[] }) {
  return (
    <div className="intro-slides">
      {slides.map((slide, index) => (
        <div className="intro-slide" key={index}>
          <div className="intro-slide-head"><span className="intro-slide-type">{slide.slideType}</span>{slide.section ? <span> · {slide.section}</span> : null}<strong>{slide.title}</strong></div>
          <ul>{slide.keyPoints.map((point, pointIndex) => <li key={pointIndex}>{point}</li>)}</ul>
          {slide.notes ? <p className="intro-slide-notes">{slide.notes}</p> : null}
          {slide.anchors.length > 0 ? <div className="intro-slide-anchors">{slide.anchors.map((anchor, anchorIndex) => <code key={anchorIndex}>{anchor.kind}#{anchor.id}</code>)}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** 介绍材料动线（GTM 桥面批次 2）：定位块 → AI 大纲（账本锚定）→ PPT 烧片 → 下载。 */
export function IntroMaterialPanel({ slug, canEdit }: { slug: string; canEdit: boolean }) {
  const guard = useDemoGuard();
  const [state, setState] = useState<IntroMaterialState | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pptStatus, setPptStatus] = useState<string | null>(null);
  const [pptError, setPptError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await loadIntroMaterial(slug);
      setState(data);
      setLoadFailed(null);
      setPptStatus(data.material?.ppt.status ?? null);
      setPptError(data.material?.ppt.error ?? null);
    } catch (cause: unknown) {
      const message = errorMessage(cause, "加载介绍材料失败");
      setLoadFailed(message === "未登录" ? "登录后可在工作区生成介绍材料与 PPT。" : message);
    }
  }, [slug]);

  useEffect(() => { void load(); return () => { if (pollRef.current) clearInterval(pollRef.current); }; }, [load]);

  const act = async (work: () => Promise<void>, successNotice?: string) => {
    if (guard()) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await work();
      if (successNotice) setNotice(successNotice);
    } catch (cause: unknown) {
      setError(errorMessage(cause, "操作失败"));
    } finally {
      setPending(false);
    }
  };

  const poll = useCallback((slugValue: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const data = await pollPptJob(slugValue);
          setPptStatus(data.status ?? null);
          setPptError(data.error ?? null);
          if (data.status && TERMINAL.has(data.status)) {
            if (pollRef.current) clearInterval(pollRef.current);
            await load();
          }
        } catch {
          // 轮询失败静默，下一轮再试
        }
      })();
    }, 5000);
  }, [load]);

  const generate = () =>
    act(async () => {
      setGenerating(true);
      try {
        await generateIntroMaterial(slug);
        await load();
        setNotice("大纲已生成：每页要点带账本锚点，可导出后核对再烧片");
      } finally {
        setGenerating(false);
      }
    });

  const savePos = (value: IntroPositioningView) =>
    act(async () => {
      await savePositioning(slug, value);
      await load();
    }, "定位已保存");

  const startPpt = () =>
    act(async () => {
      await startPptJob(slug);
      setPptStatus("queued");
      setPptError(null);
      setNotice("PPT 任务已提交，正在烧片（约 1-3 分钟）");
      poll(slug);
    });

  const material = state?.material;
  const stale = material?.specVersionId !== null && material?.specVersionId !== undefined && state?.currentSpecVersionId !== null && state?.currentSpecVersionId !== undefined && material.specVersionId !== state.currentSpecVersionId;
  const busy = ["queued", "GENERATING"].includes(pptStatus ?? "");

  return (
    <section className="overview-panel intro-material-panel">
      <div className="overview-panel-heading"><span>04</span><h2>介绍材料</h2></div>
      <p>从行为账本生成对外介绍大纲与 PPT：事实可追溯（锚点见导出），定位主张为人工输入。</p>
      {loadFailed ? <p className="overview-note">{loadFailed}</p> : null}
      {!loadFailed && state ? (
        <>
          {canEdit ? <PositioningFields initial={state.positioning} onSave={savePos} /> : state.positioning ? <p className="overview-note">定位：{state.positioning.audience} / {state.positioning.differentiation} / {state.positioning.tone}</p> : null}
          <div className="release-notes-actions">
            {canEdit ? (
              <button className="primary-button" type="button" disabled={pending || generating} onClick={generate}>
                {generating ? "正在生成大纲（约 1-2 分钟）…" : material ? "重新生成大纲" : "生成介绍大纲"}
              </button>
            ) : null}
            {material && canEdit ? (
              <button className="secondary-button" type="button" disabled={pending || busy} onClick={startPpt}>
                {busy ? `烧片中（${pptStatus}）…` : pptStatus === "COMPLETED" ? "重新生成 PPT" : "生成 PPT"}
              </button>
            ) : null}
          </div>
          {stale ? <p className="overview-note">规格已推进（草稿对应 Spec v{material?.specVersionId}，当前 v{state.currentSpecVersionId}），重新生成以纳入最新事实。</p> : null}
          {pptError ? <p className="description-dialog-error" role="alert">PPT 任务失败：{pptError}</p> : null}
          {pptStatus && !TERMINAL.has(pptStatus) ? <p className="overview-note">PPT 状态：{pptStatus}</p> : null}
          {material ? (
            <>
              <div className="release-notes-actions">
                <a className="overview-text-link" href={`/api/products/${slug}/intro-material/export?format=markdown`}>导出大纲 Markdown ↓</a>
                <a className="overview-text-link" href={`/api/products/${slug}/intro-material/export?format=html`} target="_blank" rel="noreferrer">预览单页 HTML ↗</a>
                <a className="overview-text-link" href={`/api/products/${slug}/intro-material/export?format=outline-json`}>导出 PPT 大纲 JSON ↓</a>
                {pptStatus === "COMPLETED" ? <a className="overview-text-link" href={`/api/products/${slug}/intro-material/ppt/download`}>下载 PPTX ↓</a> : null}
              </div>
              {state.coverageNote ? <p className="overview-note">口径：{state.coverageNote}。分析成功 ≠ 完整 ≠ 正确，对外采纳前应经人工核实。</p> : null}
              <SlideList slides={material.slides} />
            </>
          ) : null}
        </>
      ) : null}
      {notice ? <p className="description-dialog-error release-notes-notice" role="status">{notice}</p> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </section>
  );
}
