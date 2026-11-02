import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { artifactAbsolutePathForRecord, type ArchitectureDocumentRecord } from "./architecture-store";

export type ArtifactReader = (path: string, encoding: "utf8") => Promise<string>;

const defaultReader: ArtifactReader = (path, encoding) => readFile(path, encoding);

function sandboxHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

export async function architectureArtifactResponse(record: ArchitectureDocumentRecord, root = process.cwd(), reader: ArtifactReader = defaultReader) {
  if (record.status !== "accepted") return NextResponse.json({ error: "架构产物尚未通过验收" }, { status: 409 });
  try {
    const path = artifactAbsolutePathForRecord(record, root);
    const html = await reader(path, "utf8");
    return new NextResponse(html, { status: 200, headers: sandboxHeaders() });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return NextResponse.json({ error: "架构产物不存在" }, { status: 404 });
    throw error;
  }
}
