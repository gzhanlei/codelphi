import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";

// zip 由 Docker 构建阶段的 `npm run radar:package` 产出并 COPY 进 runner（见 Dockerfile）。
// 本地 dev 未构建 dist 时返回 404 与构建提示，不返回半成品。
export async function GET() {
  try {
    const zip = await readFile(join(process.cwd(), "dist", "codelphi-radar.zip"));
    return new Response(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="codelphi-radar.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("codelphi-radar.zip is not built in this environment. Run `npm run radar:package` in the repository.", { status: 404 });
  }
}
