#!/usr/bin/env python3
"""直连生产 CoDelphi MCP 的调用工具（凭据取自 ~/.zcode/cli/config.json，不回显）。

用法:
  mcp-call.py tools-list                       # 列工具名（验收工具面用）
  mcp-call.py <tool> '<json-args>'             # 调用工具，打印 structuredContent
示例:
  mcp-call.py lookup_by_files '{"slug":"codelphi","paths":["lib/analysis.ts"]}'
  mcp-call.py list_releases '{"slug":"codelphi","limit":3}'
RPC 错误退出码 1；参数缺失退出码 2。
"""
import json
import os
import subprocess
import sys


def load_server():
    cfg = json.load(open(os.path.expanduser("~/.zcode/cli/config.json")))
    server = cfg["mcp"]["servers"]["codelphi"]
    auth = server["headers"]["Authorization"]
    key = auth.split(" ", 1)[1] if auth.lower().startswith("bearer ") else auth
    return server["url"], key


def rpc(url, key, payload):
    out = subprocess.run(
        ["curl", "-s", "-X", "POST", url, "-H", f"Authorization: Bearer {key}",
         "-H", "Content-Type: application/json", "-d", json.dumps(payload)],
        capture_output=True, text=True,
    )
    return json.loads(out.stdout)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    url, key = load_server()
    if sys.argv[1] == "tools-list":
        result = rpc(url, key, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        for tool in result["result"]["tools"]:
            print(tool["name"])
        return
    name = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    result = rpc(url, key, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
    if "error" in result:
        print(json.dumps(result["error"], ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result["result"]["structuredContent"], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
