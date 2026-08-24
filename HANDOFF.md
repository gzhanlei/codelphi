# 交接备忘（2026-08-24）

> 用途：清空对话上下文后的续接入口。新会话先读本文件，再按需读三份文档。
> 远端仓库：`git@github.com:gzhanlei/codelphi.git`（私有，master 已推送）。
> 文档地图：
> - `DESIGN-b2b-capability-platform.md` — 设计（§1–§10 是现行正文；§10 已定默认/仍开放；§11+ 为评审与修订历史；最新决议见 §22）
> - `PLAN-p0-development.md` — P0 开发计划（§0 完工定义、§2 里程碑、§9 测试门禁、文末进度记录）
> - `CONTRACT-partner.md` — 能力提供方通用接入合同（Auth/Submit/Query/成本/旁路 2C）；新平台填附录检查表
> - `CONTRACT-pptcreator-partner.md` — PPTCreator 实例（v1.2，C0–C7；C2 = `documents[]` / `create_ppt_from_documents`）

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

- **产品名词**：工作台叫「我的课程」（路由仍是 `/projects`）。一个项目是一套课程，一课是项目内单元。卖的是 **预设包**（License.presets），不是 `org.industry`。P0 只卖 `digital_lesson`；多包时只在新建选一次。内核改进见 `PLAN-p0-development.md` §2.1 M5b、设计 §2.3
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
- `POST /v1/projects/{id}/lessons/{lid}/materials`（pdf/docx/md/txt，每课最多 5 份）· `POST /v1/projects/{id}/lessons/{lid}/submit`（202）
- `POST /v1/lessons/{id}/confirm`（202，id 是 job）· `GET /v1/packages/{id}`（签名 URL，无文件字节）
- `POST /mcp` JSON-RPC：`tools/list`、`tools/call`（`get_package` / `submit_lesson`；submit 无 `lesson_id` 且非 rebuild → `project_unspecified`）
- 启动时 `RecoverInFlight`：残留 queued/running → failed，package partial；预扣靠 billing TTL
- viewer 角色写接口 403 `forbidden`

## 下一步（按序）

1. **提供生产 MySQL DSN** 写进 `/data/www/codelphi/gateway.env`（必须 `loc=Local`），`systemctl restart codelphi-gateway`，`/healthz` 应变 `db:ok`，`/v1` 才会挂上。没有这一步，登录后工作台调不了 API
2. **联调**：生产已配 `PPTCREATOR_PARTNER_BASE_URL=https://app.easymakeppt.com`（站点根，请求打到 `/mcp`）和 `PPTCREATOR_PARTNER_KEY`。网关直调 `create_ppt_from_documents` + `get_generation_status`，四个 C1 头都带。真机跑一条过 C6。对方默认 `verify-partner-mode.ts` 主路径仍是 `create_ppt_from_text`，材料包要用 `--multi-doc`。
3. **M4 运营后台**：License pending→active（双人确认）、CSV 导入成员、成员用量 Top 报表、成本预警（按 capability 拆）。没有这条，试点教师进不来（完工定义 1–2）
4. DSH 返工对话后嵌（空聊天不上线）

## PPTCreator 协同

- 那边走 GitHub Issue 流程（其 AGENTS.md 约定）：Epic **#106**（§8 十条）、**#107**（C1 认证）、**#116**（多文档方向一，MCP `create_ppt_from_documents` 已落地）、**#119**（契约 v1.1 三澄清：spec.note/critique 必进提示词、usage.pages=实际页数、四个上下文头覆盖全部端点含查询）
- 联调约定：契约 C6 验收测试（积分不变、不锁下载、UsageRecord settled、C 端 dashboard 不可见、讲稿非空页数对齐）
- **网关已切方向一**：adapter 直调 MCP `POST /mcp` `tools/call` **`create_ppt_from_documents`**（`documents[]`：恰好一份 `textbook` + 当前 design 作 `teaching_design` + 其余材料/大纲作 `reference`）。不调 `create_ppt_from_text`，也不发 REST `/generate`（PPTCreator 无此路由）。

## 待确认清单（PLAN §11）

对象存储选型（默认腾讯 COS）/ DSH 会话持久化 backend / 数字人、AI3D 正式产品名。PPTCreator 方向一网关侧已切（C2 v1.2）。
设计层面仍开放（销售开口前书面）：教材正文合规口径、试点校组织细节、内部报价模型、OpenMAIC spike 两周结论。

## 安全注意

- secret 只进 `/data/www/codelphi/gateway.env` 与本机 `web/.env.local`，不进仓库、不进对话（本会话曾意外回显过一次 chandler secret，建议方便时轮换）
- 本地 MySQL root 密码出现在本文件纯属用户明确同意（本机环境）
