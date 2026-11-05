"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createProduct } from "@/lib/product-client";
import { errorMessage } from "@/lib/error-message";
import { defaultConnectionId, nextProductSlug } from "@/lib/product-input";
import { ProductSubmissionSection } from "./product-submission-section";
import { ProductInformationSection, RepositorySection } from "./product-form-sections";

interface ProductCreationControls {
  setPending: (pending: boolean) => void;
  setError: (message: string) => void;
  onCreated: () => void;
}

type ProductInput = Parameters<typeof createProduct>[0];

export async function handleProductCreation(input: ProductInput, controls: ProductCreationControls, create: (input: ProductInput) => Promise<string> = createProduct) {
  controls.setPending(true);
  controls.setError("");
  try {
    await create(input);
    controls.onCreated();
  } catch (cause) {
    controls.setError(errorMessage(cause, "添加产品失败"));
    controls.setPending(false);
  }
}

export function NewProductForm({ connections, hasServerToken }: { connections: Array<{ id: number; accountLogin: string }>; hasServerToken: boolean }) {
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
  const [connectionId, setConnectionId] = useState<number | null>(defaultConnectionId(connections));

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
    await handleProductCreation({ name, slug, repository, provider: "github", defaultBranch, description, analyze, connectionId }, {
      setPending,
      setError,
      onCreated: () => {
        router.push("/");
        router.refresh();
      },
    });
  }

  return (
    <form className="product-form" onSubmit={submit}>
      <ProductInformationSection name={name} slug={slug} description={description} onNameChange={updateName} onSlugChange={updateSlug} onDescriptionChange={setDescription} />
      <RepositorySection repository={repository} defaultBranch={defaultBranch} connectionId={connectionId} connections={connections} hasServerToken={hasServerToken} onRepositoryChange={setRepository} onBranchChange={setDefaultBranch} onConnectionChange={setConnectionId} />
      <ProductSubmissionSection analyze={analyze} error={error} pending={pending} onAnalyze={setAnalyze} />
    </form>
  );
}
