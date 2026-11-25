# CoDelphi 开发约定

- 数据库使用现有腾讯云 MySQL 8；不要引入 PostgreSQL 或本地数据库容器。
- CoDelphi 使用独立数据库，不直接读取或修改 WorkMembership 业务表。
- 统一登录使用 Chandler OAuth 授权码 + PKCE，不新增账号密码体系。
- 所有密钥仅通过环境变量配置，不提交 `.env` 或真实凭证。
- AI 生成的产品事实必须带可追溯代码证据；不要绕过证据校验。
- 自动分析不得覆盖 `source = 'manual'` 的功能或场景。
- 未经用户明确要求，不执行生产部署、DNS 修改、Webhook 配置或 Docker 镜像构建推送。
- 提交前运行 `npm run typecheck`、`npm test` 和 `npm run build`。

## 行为账本（CoDelphi MCP）：本仓库 coding agent 的工作方式

本仓库的产品行为账本通过 MCP 服务 `codelphi` 提供（slug 同名）。这是 coding agent 在本仓库的标准工作方式，不是可选试验——编码周期内自觉执行（完整配方见 `docs/coding-agent-mcp.md`）：

- 做计划时（早于任何文件改动）：`lookup_by_files` 反查**计划要改的文件**是哪些功能/场景的证据（爆炸半径），把回归红线场景与 push 后对账锚点写进计划；必要时 `get_feature_connections(path)` 看共享该文件的功能邻域。方案已定但未反查 = 计划未完成，不得动手。
- 需要理解既有行为时：`search_scenarios` 检索规格原文，用返回的 `stableKey` 深入 `get_feature`。
- push 后：`list_releases` 找到本次 sha 对应的发布，`get_release` 核对行为变化清单与意图一致；计划外的变化要回查。
- 发现账本与代码不符：`send_feedback` 上报，AI 裁决管线自动核实处置（确认缺陷即触发修复性重建，误报驳回），仅证据不足的进入人工队列；账本是只读面，且「没搜到 ≠ 不存在」（以 `specSnapshot` + `evidenceCoverage` 判断账本新旧与覆盖）。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->


## CoDelphi 行为咨询（本仓 agent 必须遵守）

你有一个叫 CoDelphi 的软件行为知识专家。它了解这个软件的用户行为、行为之间的关系，以及这些行为对应的代码。**任务涉及既有产品行为、行为之间的关系或其代码证据时，必须在形成设计结论、制定实施方案或修改文件前主动咨询 CoDelphi。新功能只要依赖、扩展或改变既有行为，也属于必问范围。** 典型问题包括日志何时记录、缓存命中是否计数、每日汇总口径、热点词聚合规则、权限和数据权益。不得以“可以直接阅读源码”或“稍后再补问”为由跳过咨询。纯机械修改且不涉及既有行为语义的改动可以不咨询。

咨询要覆盖会影响设计的具体行为分支。CoDelphi 提供的信息可能不完整或过期，你需要独立判断，不能用它的回答替代源码阅读、测试或用户/产品裁决。具体使用与记录方式见 `artifacts/agent-consultations/consultation-guide.md`。

每次有效问答后记录：

```bash
npx tsx /Users/leihan/Documents/GitHub/codelphi/scripts/log-agent-consultation.ts --file /tmp/codelphi-consultation.json
```

JSON 至少包含 `project:"codelphi"`、`task`、`question`、`answer`、`evidence`、`unknowns`、`decisionImpact`、`nextAction`，可加 `repository/branch/sha`。`nextAction` 只能为 `verify|escalate|may_proceed|none`。

- 不记录 token、`.env`、用户隐私或完整敏感代码。
- 不记录无决策影响的机械修改或重复问题。
- 不把 unknown/product decision 写成默认答案；外部平台事实必须用官方文档或真实响应验证。
- 回答基于旧快照、结果被截断、只提供相关材料或未覆盖所有行为分支时，不得声称 CoDelphi 已确认完整行为，也不得把未覆盖解释为“没有该行为”；列出未决分支，缩小范围继续追问，并以当前源码和测试验证。
- 旧快照与当前代码的差异、无法追问的分支及覆盖限制必须写入 `unknowns`，据此选择 `verify` 或 `escalate`，不能用确定语气补齐答案。
- 若 CoDelphi MCP 不可用，不得伪造账本结论，只能记录基于源码/证据的回答及覆盖限制。
- 阶段评审使用 `artifacts/agent-consultations/codelphi.md` 与 `codelphi.jsonl`，不回改历史，只追加更正。
