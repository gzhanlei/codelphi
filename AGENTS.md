# CoDelphi 开发约定

- 数据库使用现有腾讯云 MySQL 8；不要引入 PostgreSQL 或本地数据库容器。
- CoDelphi 使用独立数据库，不直接读取或修改 WorkMembership 业务表。
- 统一登录使用 Chandler OAuth 授权码 + PKCE，不新增账号密码体系。
- 所有密钥仅通过环境变量配置，不提交 `.env` 或真实凭证。
- AI 生成的产品事实必须带可追溯代码证据；不要绕过证据校验。
- 自动分析不得覆盖 `source = 'manual'` 的功能或场景。
- 未经用户明确要求，不执行生产部署、DNS 修改、Webhook 配置或 Docker 镜像构建推送。
- 提交前运行 `npm run typecheck`、`npm test` 和 `npm run build`。

## Dogfood：本仓库的 coding agent 用 CoDelphi MCP

本仓库的产品账本在 MCP slug `codelphi` 上（dogfood）。编码周期内按以下习惯使用（完整配方见 `docs/coding-agent-mcp.md`）：

- 动手改文件前：`lookup_by_files` 反查该文件是哪些功能/场景的证据（爆炸半径）；必要时 `get_feature_connections(path)` 看共享该文件的功能邻域。
- 需要理解既有行为时：`search_scenarios` 检索规格原文，用返回的 `stableKey` 深入 `get_feature`。
- push 后：`list_releases` 找到本次 sha 对应的发布，`get_release` 核对行为变化清单与意图一致；计划外的变化要回查。
- 发现账本与代码不符：`send_feedback` 上报由人裁决；账本是只读面，且「没搜到 ≠ 不存在」（以 `specSnapshot` + `evidenceCoverage` 判断账本新旧与覆盖）。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
