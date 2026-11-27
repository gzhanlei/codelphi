import { errorMessageFromData } from "./error-message";

/** 设置页看到的工作区模型配置：服务端从来不把 key 给出来。 */
export interface OrganizationModelView {
  baseUrl: string;
  model: string;
  verifiedAt: string | Date | null;
  updatedAt?: string | Date | null;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const PATH = "/api/organization-model";

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** 服务端拒绝时给页面看的一句话：有解释用解释（比如删除被拒时说哪些产品还在用），没有就用错误文字。 */
function problem(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.message === "string" && data.message) return data.message;
  return errorMessageFromData(data, fallback);
}

/** 工作区当前的模型配置；没有就是 null。 */
export async function loadOrganizationModel(fetcher: Fetcher = fetch): Promise<OrganizationModelView | null> {
  const response = await fetcher(PATH, { cache: "no-store" });
  const data = await bodyOf(response);
  if (!response.ok) throw new Error(problem(data, "读取模型配置失败"));
  return (data.model as OrganizationModelView | null | undefined) ?? null;
}

/** 验证并保存。服务端先用这一份真调一次模型；没通过就抛出它说的原因，什么也不保存。 */
export async function saveOrganizationModel(input: { baseUrl: string; apiKey: string; model: string }, fetcher: Fetcher = fetch): Promise<OrganizationModelView> {
  const response = await fetcher(PATH, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const data = await bodyOf(response);
  const saved = data.model as OrganizationModelView | undefined;
  if (!response.ok || data.status !== "saved" || !saved) throw new Error(problem(data, "保存模型配置失败"));
  return saved;
}

export async function deleteOrganizationModel(fetcher: Fetcher = fetch): Promise<"deleted"> {
  const response = await fetcher(PATH, { method: "DELETE" });
  const data = await bodyOf(response);
  if (!response.ok || data.status !== "deleted") throw new Error(problem(data, "删除模型配置失败"));
  return "deleted";
}
