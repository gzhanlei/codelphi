import type { IntroSlideDraft } from "./intro-material";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function parse<T extends { error?: string }>(response: Response, fallback: string): Promise<T> {
  const data = await response.json() as T;
  if (!response.ok) throw new Error(data.error ?? fallback);
  return data;
}

export interface IntroPositioningView { audience: string; differentiation: string; tone: string }

export interface IntroMaterialState {
  currentSpecVersionId: number | null;
  positioning: IntroPositioningView | null;
  coverageNote: string | null;
  material: {
    id: number;
    specVersionId: number | null;
    slides: IntroSlideDraft[];
    status: string;
    ppt: { projectId: string | null; jobId: string | null; status: string | null; error: string | null };
    updatedAt: string | null;
  } | null;
}

export async function loadIntroMaterial(slug: string, fetcher: Fetcher = fetch): Promise<IntroMaterialState> {
  const response = await fetcher(`/api/products/${slug}/intro-material`, { cache: "no-store" });
  return parse<IntroMaterialState & { error?: string }>(response, "加载介绍材料失败");
}

export async function generateIntroMaterial(slug: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/intro-material`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  await parse(response, "生成介绍材料失败");
  return "generated" as const;
}

export async function savePositioning(slug: string, positioning: IntroPositioningView, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positioning }),
  });
  await parse(response, "保存定位失败");
  return "saved" as const;
}

export async function startPptJob(slug: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/intro-material/ppt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await parse<{ status?: string; error?: string }>(response, "提交 PPT 任务失败");
  return data;
}

export async function pollPptJob(slug: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/intro-material/ppt`, { cache: "no-store" });
  const data = await response.json() as { status?: string | null; ready?: boolean; error?: string | null };
  if (!response.ok) throw new Error((typeof data.error === "string" && data.error) || "查询 PPT 状态失败");
  return data;
}
