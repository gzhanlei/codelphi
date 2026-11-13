/**
 * 通用 mcpServers 连接配置模板（Streamable HTTP 客户端通用形状：
 * Claude Code 项目 .mcp.json / ZCode mcp.servers 同形状 / Cursor mcp.json 等）。
 * 纯函数，不碰 window；端点由调用方传入（服务端 appUrl()、客户端 origin 推导）。
 */

export const MCP_KEY_PLACEHOLDER = "<sk_cd_…>";

export function mcpServerConfig(endpoint: string, key?: string | null) {
  return {
    mcpServers: {
      codelphi: {
        type: "http",
        url: endpoint,
        headers: {
          Authorization: `Bearer ${key?.trim() ? key.trim() : MCP_KEY_PLACEHOLDER}`,
        },
      },
    },
  };
}

export function mcpServersJson(endpoint: string, key?: string | null) {
  return JSON.stringify(mcpServerConfig(endpoint, key), null, 2);
}
