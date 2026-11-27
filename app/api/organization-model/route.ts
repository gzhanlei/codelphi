import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requestStructuredCompletionDetailed } from "@/lib/ai";
import { getDb } from "@/lib/db";
import { requireOrganization } from "@/lib/organizations";
import { MODEL_NAME_MAX_LENGTH, ModelInUseError, ModelUrlError, assertPublicModelUrl, bindOrganizationModel, deleteOrganizationModel, describeOrganizationModel, saveOrganizationModel } from "@/lib/organization-model";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";
/** 验证那一次调用最长等到模型的超时（AI_TIMEOUT_MS，默认 180 秒）。 */
export const maxDuration = 300;

const FORBIDDEN = { error: "只有工作区成员可以管理模型配置" };

// 缺了哪一项都说人话（zod 默认的「expected string, received undefined」不给用户看）。
const putSchema = z.object({
  baseUrl: z.string("请填写模型服务地址").trim().min(1, "请填写模型服务地址").max(500, "模型服务地址过长"),
  apiKey: z.string("请填写 API Key").trim().min(1, "请填写 API Key").max(4_000, "API Key 过长"),
  model: z.string("请填写模型名").trim().min(1, "请填写模型名").max(MODEL_NAME_MAX_LENGTH, `模型名最多 ${MODEL_NAME_MAX_LENGTH} 个字符`),
});

/** 验证时问模型的话：只要它按 OpenAI 兼容的形状答一句，就说明地址、key 和模型名都对。 */
const VERIFY_MESSAGES = [{ role: "user", content: 'Reply with {"ok":true} and nothing else.' }];

/** 地址校验的错误码翻成给用户看的话。 */
function addressProblem(error: ModelUrlError): string {
  switch (error.code) {
    case "not_https":
      return "模型服务地址必须以 https:// 开头";
    case "credentials_in_url":
      return "模型服务地址里不能带用户名或密码";
    case "has_query":
      return "模型服务地址不能带查询串（? 后面的部分）";
    case "has_fragment":
      return "模型服务地址不能带 # 片段";
    case "no_host":
    case "invalid":
      return "模型服务地址不是一个有效的地址";
    case "not_public":
      return "模型服务地址必须是公网地址，不能是本机或内网";
    case "private_address":
      return "这个域名解析到了内网地址，不能用";
    case "unresolvable":
      return "这个域名解析不出来，请检查地址";
  }
}

/** 验证没通过的原因：地址的问题说成人话，其余的带上服务商或网络说的原因。 */
function verificationProblem(error: unknown): string {
  if (error instanceof ModelUrlError) return addressProblem(error);
  if (error instanceof Error && error.name === "TimeoutError") return "模型服务在限定时间内没有应答，请检查地址和网络";
  return error instanceof Error ? error.message : String(error);
}

/**
 * 工作区自己的模型配置（产品负责人 2026-11-27 的决定：CoDelphi 不替用户付模型费用）。
 * 组织级资源：editor/owner 可读、可保存、可删除（viewer 403）。key 加密后才进库，任何应答都不带它。
 */
export async function GET() {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "editor");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }
  return NextResponse.json({ model: await describeOrganizationModel(organization.id) });
}

/** 保存之前用用户刚填的这一份配置真调一次模型；通过了才加密入库，不通过什么也不保存。 */
export async function PUT(request: NextRequest) {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "editor");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "请填写模型服务地址、API Key 和模型名" }, { status: 400 });
  const { baseUrl, apiKey, model } = parsed.data;
  // 第一道地址校验在这里（只认 https 的公网地址）；解析域名、把连接钉在校验过的地址上，是发请求时做的。
  let url: URL;
  try {
    url = assertPublicModelUrl(baseUrl);
  } catch (error) {
    if (error instanceof ModelUrlError) return NextResponse.json({ error: addressProblem(error) }, { status: 400 });
    throw error;
  }
  let answer: Awaited<ReturnType<typeof requestStructuredCompletionDetailed>>;
  try {
    answer = await bindOrganizationModel({ organizationId: organization.id, baseUrl: url.href, apiKey, model }, () => requestStructuredCompletionDetailed(VERIFY_MESSAGES));
  } catch (error) {
    return NextResponse.json({ error: `模型没有通过验证：${verificationProblem(error)}` }, { status: 400 });
  }
  if (answer.finishReason === "length" || answer.content.trim() === "") {
    return NextResponse.json({ error: "模型没有通过验证：模型没有返回内容（回答被截断或者为空）" }, { status: 400 });
  }
  await saveOrganizationModel((statement, parameters) => getDb().execute(statement, parameters), { organizationId: organization.id, baseUrl: url.href, apiKey, model, by: user.sub });
  return NextResponse.json({ status: "saved", model: await describeOrganizationModel(organization.id) });
}

/** 删除。这个工作区还有产品由服务端分析时拒绝，并说出是哪些：删了它们就分析不了了。 */
export async function DELETE() {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "editor");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }
  try {
    await deleteOrganizationModel(organization.id);
  } catch (error) {
    if (!(error instanceof ModelInUseError)) throw error;
    return NextResponse.json(
      {
        error: error.code,
        products: error.products,
        message: `还有产品由服务端分析：${error.products.join("、")}。删掉模型配置后它们无法分析。先把它们改成客户端分析，再删除。`,
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ status: "deleted" });
}
