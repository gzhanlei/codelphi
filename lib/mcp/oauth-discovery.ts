import { appUrl } from "@/lib/env";

/**
 * OAuth 自动发现元数据（RFC 8414 授权服务器 / RFC 9728 受保护资源）。
 * issuer = 站点 origin（APP_URL）；端点复用既有 /api/mcp/oauth/*。
 * scope 语义：只读工具面 + send_feedback（与 API key 面一致）。
 */
export function protectedResourceMetadata() {
  const base = appUrl();
  return {
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: ["mcp:read"],
    resource_documentation: `${base}/mcp`,
  };
}

export function authorizationServerMetadata() {
  const base = appUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/api/mcp/oauth/authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
    code_challenge_methods: ["S256"],
    token_endpoint_auth_method: "none",
    scopes_supported: ["mcp:read"],
  };
}

/** 发现端点公共响应头：公开元数据允许跨域读，短缓存。 */
export const DISCOVERY_HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=300",
} as const;
