import { getAccessToken, getOrgId } from "./session";

const gateway = () => process.env.GATEWAY_URL || "http://127.0.0.1:18080";

export type APIError = {
  code: string;
  message: string;
  admin_hint?: string;
};

export class GatewayError extends Error {
  status: number;
  code: string;
  adminHint: string;
  constructor(status: number, err: APIError) {
    super(err.message || err.code);
    this.status = status;
    this.code = err.code;
    this.adminHint = err.admin_hint || "联系本机构管理员";
  }
}

export async function gw<T>(
  path: string,
  init: RequestInit & { orgId?: string } = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new GatewayError(401, { code: "missing_token", message: "未登录" });
  }
  const orgId = init.orgId ?? (await getOrgId());
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (orgId) headers.set("X-Org-Id", orgId);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${gateway()}${path}`, { ...init, headers, cache: "no-store" });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const err = (data as { error?: APIError })?.error;
    throw new GatewayError(res.status, err || { code: "http_error", message: text || res.statusText });
  }
  return data as T;
}

export type Membership = {
  member_id: string;
  org_id: string;
  org_name: string;
  role: string;
  status: string;
  units: { id: string; name: string }[];
  presets?: string[];
};

export type Me = { sub: string; memberships: Membership[] };

export type Project = {
  id: string;
  org_id: string;
  unit_id?: string;
  owner_member_id: string;
  title: string;
  preset_id?: string;
};

export type PresetCopy = {
  list_title: string;
  list_hint: string;
  create_cta: string;
  create_title: string;
  title_label: string;
  title_hint: string;
  lesson_cta: string;
  lesson_title: string;
  lesson_title_label: string;
  lesson_title_hint: string;
  empty_lessons: string;
  materials_hint: string;
  submit_cta: string;
  confirm_cta: string;
  confirm_hint: string;
  empty_list: string;
  artifact_labels: Record<string, string>;
};

export type CourseLesson = {
  id: string;
  title: string;
  package_id?: string;
  package_status?: string;
  lesson_job_id?: string;
};

export type LessonMaterial = {
  id: string;
  kind: string;
  filename?: string;
};

export type Preset = {
  id: string;
  copy: PresetCopy;
  artifacts: string[];
  steps: { capability: string; platform: string; gate_after?: boolean; emits: string[] }[];
};

export type PresetsResponse = {
  entitled: string[];
  presets: Preset[];
};

export type Lesson = {
  lesson_job_id: string;
  package_id: string;
  status: string;
};

export type PackageSnap = {
  id: string;
  project_id: string;
  status: string;
  lesson_job_id?: string;
  lesson_status?: string;
  error?: APIError;
  steps?: { id: string; capability: string; status: string; error?: APIError }[];
  artifacts?: {
    kind: string;
    current?: { id: string; version: number; status: string; url?: string };
    versions: { id: string; version: number; status: string; url?: string }[];
  }[];
};
