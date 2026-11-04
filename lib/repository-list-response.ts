import { NextResponse } from "next/server";
import { RepositoryListError } from "./github-repositories";

export function repositoryListErrorResponse(error: unknown) {
  if (error instanceof RepositoryListError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: error instanceof Error ? error.message : "仓库列表读取失败" }, { status: 500 });
}
