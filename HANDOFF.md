# 交接备忘（2026-08-24）

> 用途：清空对话上下文后的续接入口。新会话先读本文件，再按需读三份文档。
> 远端仓库：`git@github.com:gzhanlei/codelphi.git`（私有，master 已推送）。
> 文档地图：
> - `DESIGN-b2b-capability-platform.md` — 设计（§1–§10 是现行正文；§2.4 数字教材插件切分；§10 已定默认/仍开放；§11+ 为评审与修订历史；最新决议见 §23）
> - `PLAN-p0-development.md` — P0' 开发计划（§0 完工定义已重切、§2.2 M5c/M2c、§9 测试门禁）
> - `CONTRACT-partner.md` — 能力提供方通用接入合同
> - `CONTRACT-pptcreator-partner.md` — PPTCreator 实例（v1.5，C0–C8；C8 = 课件大纲交回/写回）

## 当前状态

| 里程碑 | 状态 | 要点 |
|---|---|---|
| M0 地基 | ✅ 完成 | Go 仓骨架、13+2 表 goose 迁移、sqlc 打通、storage 接口 + local 驱动、二进制 + systemd 部署管线 |
| M1 计费闭环 | ✅ 完成 | `internal/billing`：Authorize/Settle/SweepExpired/Reconcile；14 测试绿 |
| M1 身份链 | ✅ 完成 | `internal/identity`：JWKS 验签、Resolver（§5 归属规则 + 缓存主动失效）、中间件；19 测试绿 |
| M3 状态机 | ✅ 完成 | `internal/execution`：lesson 状态机 + adapters/llm + adapters/pptcreator；含 StartLesson 异步 + RecoverInFlight / SweepTimedOut |
| M5 网关 HTTP/MCP | ✅ 完成 | `internal/httpapi` REST + MCP `get_package`/`submit_lesson`；identity 中间件已接线；6 测试绿 |
| M5 工作台 Web | ✅ 已部署未接库 | `https://app.codelphi.com/login`；nginx 分流 `/v1` `/media` `/mcp` `/healthz` → gateway :18080，其余 → Next.js :13000。登录后 API 仍 404，因 **缺 MYSQL_DSN** |
| M4 运营后台 | ⬜ 未开 | License 开通、CSV 导入、用量报表、成本预警看板 |
| M2 PPTCreator partner | 🔵 对方在改 | Epic gzhanlei/PPTCreator#106；契约更新已发 #119 |
| 联调 | ⬜ 待 M2 | 用真 partner 端点替换 httptest 假 server 跑 happy path |

验证命令：`go build ./... && go vet ./... && go test ./internal/... -count=1 -race`
（测试连本地真实 MySQL，每包独立测试库，TestMain 自动建库迁移）
工作台：`cd web && npm install && npm run dev`（先起网关 `HTTP_ADDR=:18080`）

## 关键事实

- **产品名词**：对外卖 **数字教材建设能力**。PPTCreator = **做片**，课件由 **harness**（编排 / agent loop / 验收）收成，实现不必是 DSH。大纲/教案改稿 = 左对话右预览。本地改过的 **pptx 必须能导回**为新版本（不是当材料重传）。不为成本设确认门。后补见设计 §2.4。现行 `digital_lesson`：材料 → **课件大纲 + ppt + 讲稿**（无确认门）；讲稿可 **整理成教案**（`plan`，不挡套件 ready）
- **生产机**：124.156.160.168（VM-32-3，ssh root 直连，本机有密钥）。旧机 101.32.49.240（VM-16-7）已挂，弃用
- **域名**：`https://app.codelphi.com` → nginx → `127.0.0.1:18080` → systemd 服务 `codelphi-gateway`（二进制 `/data/www/codelphi/gateway`，不用 Docker；8080–8084 被该机别的服务占用，故用 18080）
- **部署**：`./scripts/deploy.sh` 网关；`./scripts/deploy-web.sh` 工作台。nginx 已切 `deploy/nginx-codelphi-m5.conf`（证书行保留）。Next 听 `127.0.0.1:13000`（3000 是 chandler）
- **服务器 env**：`/data/www/codelphi/gateway.env` 已有 HTTP_ADDR / STORAGE_* / MEDIA_SIGNING_KEY / CHANDLER_JWKS_URL / CHANDLER_ISSUER / CHANDLER_CLIENT_ID / CHANDLER_CLIENT_SECRET。**缺 MYSQL_DSN**（腾讯云 MySQL 集群连接信息待提供；DSN 必须带 `loc=Local`）。M5 新增可选：`PUBLIC_BASE_URL`（默认 `https://app.codelphi.com`）、`CORS_ORIGINS`、`JOB_TIMEOUT`（默认 30m）、`DESIGN_LLM_API_KEY`
- **本地 MySQL**：127.0.0.1:3306，root / yuntouyan333（库 codelphi / codelphi_test*）
- **chandler**：JWKS=`https://api.chandler.work/.well-known/jwks.json`，iss=`workmembership`，client_id=`cm_aca9bb839faa4a4a96839b389f312636`（单应用单 client，无 token exchange）；authorize=`https://api.chandler.work/v1/oauth/authorize`，token=`https://api.chandler.work/v1/oauth/token`（PKCE S256 + client_secret_post）。生产回调 `https://app.codelphi.com/auth/callback` 仍是网关 stub；工作台本地回调 `http://localhost:3000/auth/callback`（需在 chandler 给该 client 加一条）
- **LLM vendor**：DeepSeek，`DEEPSEEK_API_KEY` 在本机 ~/.zshrc（remoteOpenAI 变量组，与 PPTCreator 2C 共用额度）。网关读 `DESIGN_LLM_API_KEY`（本地可 `export DESIGN_LLM_API_KEY=$DEEPSEEK_API_KEY`）
- **证书**：certbot 管 app.codelphi.com，自动续期 timer + reload hook 已配

## 网关 HTTP 面（工作台 / MCP）

鉴权：`Authorization: Bearer <chandler JWT>` + 可选 `X-Org-Id` / `X-Unit-Id`。`GET /v1/me` 只验签、列出 memberships（多机构时不 403，供选择器）。其余 `/v1/*` 与 `POST /mcp` 走 identity 中间件。

- `GET /v1/me`
- `GET|POST /v1/projects` · `GET /v1/projects/{id}`（含 `lessons[]`）· `POST /v1/projects/{id}/lessons` · `GET /v1/projects/{id}/lessons/{lid}`
- `POST /v1/projects/{id}/lessons/{lid}/materials`（pdf/docx/md/txt，每课最多 5 份）· `POST /v1/projects/{id}/lessons/{lid}/submit`（202，直接做片）
- `POST /v1/packages/{id}/artifacts/ppt`（导回本地 pptx，新版本；无 UsageRecord）· `POST /v1/packages/{id}/lesson-plan`（讲稿整理成教案栏目）· `GET /v1/packages/{id}`（签名 URL，无文件字节）
- `POST /v1/lessons/{id}/confirm` 仍在（历史 job）；工作台已撤确认按钮
- `POST /mcp` JSON-RPC：`tools/list`、`tools/call`（`get_package` / `submit_lesson` / `reshape_lesson_plan`；submit 无 `lesson_id` 且非 rebuild → `project_unspecified`）
- 启动时 `RecoverInFlight`：残留 queued/running → failed，package partial；预扣靠 billing TTL
- viewer 角色写接口 403 `forbidden`

## 下一步（按序）

1. **真机联调 C6**（本地可跳过 Chandler：`scripts/dev-seed.sh` + `CODELPHI_DEV_AUTH_SUB=dev-local` + 工作台 `DEV_AUTH=1`）
2. **提供生产 MySQL DSN**（若生产 `/healthz` 仍 db 未接）写进 `/data/www/codelphi/gateway.env`（必须 `loc=Local`）
3. **M4 运营后台**（完工定义 1–2）
4. Harness 选型 spike（空聊天不上线）

## PPTCreator 协同

- 那边走 GitHub Issue 流程（其 AGENTS.md 约定）：Epic **#106**（§8 十条）、**#107**（C1 认证）、**#116**（多文档方向一，MCP `create_ppt_from_documents` 已落地）、**#119**（契约 v1.1 三澄清：spec.note/critique 必进提示词、usage.pages=实际页数、四个上下文头覆盖全部端点含查询）
- 联调约定：契约 C6 验收测试（积分不变、不锁下载、UsageRecord settled、C 端 dashboard 不可见、讲稿非空页数对齐）
- **网关已切方向一**：adapter 直调 MCP `POST /mcp` `tools/call` **`create_ppt_from_documents`**。C8（#125）对方已完成；本仓已回拷 `outline_url` 为 `outline` 构件，Rebuild 带 `confirmed_outline`。不调 `create_ppt_from_text`，也不发 REST `/generate`。

## 待确认清单（PLAN §11）

对象存储选型（默认腾讯 COS）/ DSH 会话持久化 backend / 数字人、AI3D 正式产品名。PPTCreator 方向一网关侧已切（C2 v1.2）。
设计层面仍开放（销售开口前书面）：教材正文合规口径、试点校组织细节、内部报价模型、OpenMAIC spike 两周结论。

## 安全注意

- secret 只进 `/data/www/codelphi/gateway.env` 与本机 `web/.env.local`，不进仓库、不进对话（本会话曾意外回显过一次 chandler secret，建议方便时轮换）
- 本地 MySQL root 密码出现在本文件纯属用户明确同意（本机环境）
