# Radar 开发约定

- 数据库使用现有腾讯云 MySQL 8；不要引入 PostgreSQL 或本地数据库容器。
- Radar 使用独立数据库，不直接读取或修改 WorkMembership 业务表。
- 统一登录使用 Chandler OAuth 授权码 + PKCE，不新增账号密码体系。
- 所有密钥仅通过环境变量配置，不提交 `.env` 或真实凭证。
- AI 生成的产品事实必须带可追溯代码证据；不要绕过证据校验。
- 自动分析不得覆盖 `source = 'manual'` 的功能或场景。
- 未经用户明确要求，不执行生产部署、DNS 修改、Webhook 配置或 Docker 镜像构建推送。
- 提交前运行 `npm run typecheck`、`npm test` 和 `npm run build`。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
