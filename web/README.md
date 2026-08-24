# 套件工作台（web/）

Next.js App Router。登录走 chandler OIDC（单应用单 client，access token 直接作网关 Bearer）。

## 本地

1. 复制 `.env.local.example` 为 `.env.local`，填 `CHANDLER_CLIENT_ID` / `CHANDLER_CLIENT_SECRET`（与网关同一 client；secret 在服务器 `gateway.env`，不要进 git）。
2. 在 chandler 给该 client 加上回调 `http://localhost:3000/auth/callback`（生产已是 `https://app.codelphi.com/auth/callback`）。
3. 网关本地起来：`MYSQL_DSN=... HTTP_ADDR=:18080 go run ./cmd/gateway`
4. `npm install && npm run dev` → http://localhost:3000

## 生产分流（尚未切）

`deploy/nginx-codelphi-m5.conf`：`/v1/` `/media/` `/mcp` `/healthz` → gateway :18080；其余 → Next.js。工作台未部署前继续用现在的整站反代 gateway。
