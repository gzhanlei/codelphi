"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createProduct } from "@/lib/product-client";
import { errorMessage } from "@/lib/error-message";
import { nextProductSlug } from "@/lib/product-input";
import { FormError, ProductSubmitButton } from "./form-feedback";
import { ProductInformationSection, RepositorySection } from "./product-form-sections";

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
    setSlug(nextProductSlug(value, slug, slugEdited));
  }

  function updateSlug(value: string) {
    setSlug(value);
    setSlugEdited(true);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const productSlug = await createProduct({ name, slug, repository, defaultBranch, description, analyze });
      router.push(`/products/${productSlug}?view=spec`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, "添加产品失败"));
      setPending(false);
    }
  }

  return (
    <form className="product-form" onSubmit={submit}>
      <ProductInformationSection name={name} slug={slug} description={description} onNameChange={updateName} onSlugChange={updateSlug} onDescriptionChange={setDescription} />
      <RepositorySection repository={repository} defaultBranch={defaultBranch} onRepositoryChange={setRepository} onBranchChange={setDefaultBranch} />
      <label className="analysis-option"><input type="checkbox" checked={analyze} onChange={(event) => setAnalyze(event.target.checked)} /><span><strong>添加后立即分析</strong><small>读取当前代码，生成第一版产品规格和发布记录。</small></span></label>
      <FormError message={error} />
      <div className="form-actions"><Link href="/" className="cancel-link">取消</Link><ProductSubmitButton pending={pending} analyze={analyze} /></div>
    </form>
  );
}
