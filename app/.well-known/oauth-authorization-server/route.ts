import { NextResponse } from "next/server";
import { authorizationServerMetadata, DISCOVERY_HEADERS } from "@/lib/mcp/oauth-discovery";

/** RFC 8414 授权服务器元数据：issuer = 站点 origin（appUrl()）。 */
export function GET() {
  return NextResponse.json(authorizationServerMetadata(), { headers: DISCOVERY_HEADERS });
}
