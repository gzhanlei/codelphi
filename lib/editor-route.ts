import { NextResponse } from "next/server";
import { SpecEditorError, specEditorErrorInfo } from "./spec-editor-service";

export function routeEntityId(value: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new SpecEditorError(400, "无效的资源 ID");
  return id;
}

export async function editorAction(action: () => Promise<unknown>, successStatus = 200) {
  try {
    return NextResponse.json(await action(), { status: successStatus });
  } catch (error) {
    const { status, message } = specEditorErrorInfo(error);
    return NextResponse.json({ error: message }, { status });
  }
}
