"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { slugifyProductName } from "@/lib/product-input";

export function NewProductForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [repository, setRepository] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [description, setDescription] = useState("");
  const [analyze, setAnalyze] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function updateName(value: string) {
    setName(value);
    if (!slugEdited) setSlug(slugifyProductName(value));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug, repository, defaultBranch, description, analyze }),
      });
      const data = await response.json() as { slug?: string; error?: string };
      if (!response.ok || !data.slug) throw new Error(data.error ?? "添加产品失败");
      router.push(`/products/${data.slug}?view=spec`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加产品失败");
      setPending(false);
    }
  }

  return (
    <form className="product-form" onSubmit={submit}>
      <div className="form-section">
        <div className="form-section-heading"><span>01</span><div><h2>产品信息</h2><p>用于在产品总览和浏览器地址中展示。</p></div></div>
        <div className="form-grid">
          <label className="field"><span>产品名称 <b>*</b></span><input value={name} onChange={(event) => updateName(event.target.value)} placeholder="例如 SalesBuddy" maxLength={100} required autoFocus /></label>
          <label className="field"><span>产品 Slug <b>*</b></span><input value={slug} onChange={(event) => { setSlug(event.target.value); setSlugEdited(true); }} placeholder="salesbuddy" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required /><small>小写字母、数字和连字符；中文名产品可填 tingfeng。</small></label>
        </div>
        <label className="field"><span>产品简介</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="一句话说明这个产品解决什么问题" rows={3} maxLength={1000} /></label>
      </div>

      <div className="form-section">
        <div className="form-section-heading"><span>02</span><div><h2>GitHub 仓库</h2><p>Radar 会验证当前 GitHub Token 是否有读取权限。</p></div></div>
        <div className="form-grid">
          <label className="field"><span>仓库 <b>*</b></span><input value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="gzhanlei/salesbuddy" required /><small>使用 owner/repo 格式，当前先接入一个主仓库。</small></label>
          <label className="field"><span>默认分支</span><input value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} placeholder="留空则读取仓库默认分支" /><small>只有这个分支的 push 会触发自动分析。</small></label>
        </div>
      </div>

      <label className="analysis-option"><input type="checkbox" checked={analyze} onChange={(event) => setAnalyze(event.target.checked)} /><span><strong>添加后立即分析</strong><small>读取当前代码，生成第一版产品规格和发布记录。</small></span></label>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="form-actions"><Link href="/" className="cancel-link">取消</Link><button className="primary-button" type="submit" disabled={pending}>{pending ? "正在验证并添加…" : analyze ? "添加并开始分析" : "添加产品"}</button></div>
    </form>
  );
}
