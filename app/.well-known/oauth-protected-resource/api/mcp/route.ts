import { NextResponse } from "next/server";
import { DISCOVERY_HEADERS, protectedResourceMetadata } from "@/lib/mcp/oauth-discovery";

/** RFC 9728 路径插入式推导：资源 https://host/api/mcp → 本路由；401 的 WWW-Authenticate 直接指向这里。 */
export function GET() {
  return NextResponse.json(protectedResourceMetadata(), { headers: DISCOVERY_HEADERS });
}
