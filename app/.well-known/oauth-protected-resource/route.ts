import { NextResponse } from "next/server";
import { DISCOVERY_HEADERS, protectedResourceMetadata } from "@/lib/mcp/oauth-discovery";

/** RFC 9728 受保护资源元数据（根路径推导式；/api/mcp 资源的路径插入式见 api/mcp 子路由）。 */
export function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: DISCOVERY_HEADERS });
}
