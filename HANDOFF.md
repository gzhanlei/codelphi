# 交接备忘（2026-08-24）

> 用途：清空对话上下文后的续接入口。新会话先读本文件，再按需读三份文档。
> 远端仓库：`git@github.com:gzhanlei/codelphi.git`（私有，master 已推送）。
> 文档地图：
> - `DESIGN-b2b-capability-platform.md` — 设计（§1–§10 是现行正文；§10 已定默认/仍开放；§11+ 为评审与修订历史；最新决议见 §22）
> - `PLAN-p0-development.md` — P0 开发计划（§0 完工定义、§2 里程碑、§9 测试门禁、文末进度记录）
> - `CONTRACT-pptcreator-partner.md` — 与 PPTCreator 的唯一接缝（v1.1，C0–C7）

## 当前状态

| 里程碑 | 状态 | 要点 |
|---|---|---|
| M0 地基 | ✅ 完成 | Go 仓骨架、13+2 表 goose 迁移、sqlc 打通、storage 接口 + local 驱动、二进制 + systemd 部署管线 |
| M1 计费闭环 | ✅ 完成 | `internal/billing`：Authorize/Settle/SweepExpired/Reconcile；14 测试绿 |
| M1 身份链 | ✅ 完成 | `internal/identity`：JWKS 验签、Resolver（§5 归属规则 + 缓存主动失效）、中间件；19 测试绿 |
| M3 状态机 | ✅ 完成 | `internal/execution`：lesson 状态机（design→outline→awaiting_confirm→ppt+script，确认门零预扣，按 step 扣费）+ adapters/llm（DeepSeek）+ adapters/pptcreator（按契约，假 server 测试）；10 测试绿 |
| M4 运营后台 | ⬜ 未开 | License 开通、CSV 导入、用量报表、成本预警看板 |
| M5 工作台 | ⬜ 下一个 | Next.js 工作台 + 网关 HTTP API 接线；DSH 返工后嵌 |
| M2 PPTCreator partner | 🔵 对方在改 | Epic gzhanlei/PPTCreator#106；契约更新已发 #119 |
| 联调 | ⬜ 待 M2 | 用真 partner 端点替换 httptest 假 server 跑 happy path |

验证命令：`go build ./... && go vet ./... && go test ./internal/... -count=1 -race`
（测试连本地真实 MySQL，每包独立测试库，TestMain 自动建库迁移）

## 关键事实

- **生产机**：124.156.160.168（VM-32-3，ssh root 直连，本机有密钥）。旧机 101.32.49.240（VM-16-7）已挂，弃用
- **域名**：`https://app.codelphi.com` → nginx → `127.0.0.1:18080` → systemd 服务 `codelphi-gateway`（二进制 `/data/www/codelphi/gateway`，不用 Docker；8080–8084 被该机别的服务占用，故用 18080）
- **部署**：`./scripts/deploy.sh`（交叉编译 → scp → systemctl 重启，幂等）；迁移 `./scripts/migrate.sh "<dsn>"`
- **服务器 env**：`/data/www/codelphi/gateway.env` 已有 HTTP_ADDR / STORAGE_* / MEDIA_SIGNING_KEY / CHANDLER_JWKS_URL / CHANDLER_ISSUER / CHANDLER_CLIENT_ID / CHANDLER_CLIENT_SECRET。**缺 MYSQL_DSN**（腾讯云 MySQL 集群连接信息待提供；DSN 必须带 `loc=Local`）
- **本地 MySQL**：127.0.0.1:3306，root / yuntouyan333（库 codelphi / codelphi_test*）
- **chandler**：JWKS=`https://api.chandler.work/.well-known/jwks.json`，iss=`workmembership`，client_id=`cm_aca9bb839faa4a4a96839b389f312636`（单应用单 client，无 token exchange）；回调 `https://app.codelphi.com/auth/callback` 已上线占位端点（网关 stub，M5 由工作台替换）；本地开发回调 `http://localhost:3000/auth/callback`
- **LLM vendor**：DeepSeek，`DEEPSEEK_API_KEY` 在本机 ~/.zshrc（remoteOpenAI 变量组，与 PPTCreator 2C 共用额度——两边都烧 token）；config 键为 `DESIGN_LLM_BASE_URL/MODEL/API_KEY`，默认 deepseek-chat
- **证书**：certbot 管 app.codelphi.com，自动续期 timer + reload hook 已配

## 下一步（按序）

1. **M5 工作台**（最大的一块）：Next.js（chandler OIDC 登录）+ 网关 HTTP API（需新增：工作台/运营后台的 REST 面 + identity 中间件接线 + MCP 工具面 get_package/submit_lesson）。注意 M3 遗留：**编排是进程内同步调用，接 HTTP 层时要补「重启恢复/超时收敛」**（in-flight job 停在 running 的收敛；预扣已有 TTL 扫尾兜底）
2. **联调**：PPTCreator partner 端点就绪后（盯 #106/#107/#116/#119），配 `PPTCREATOR_PARTNER_BASE_URL/PARTNER_KEY`，真机跑一条 partner 生成，过契约 C6 验收五条
3. **M4 运营后台**：License pending→active（双人确认）、CSV 导入成员、成员用量 Top 报表、成本预警（按 capability 拆）
4. 提供生产 MySQL DSN 后写进 gateway.env 重启，健康检查应变 `db:ok`

## PPTCreator 协同

- 那边走 GitHub Issue 流程（其 AGENTS.md 约定）：Epic **#106**（§8 十条）、**#107**（C1 认证）、**#116**（多文档方向一）、**#119**（契约 v1.1 三澄清：spec.note/critique 必进提示词、usage.pages=实际页数、四个上下文头覆盖全部端点含查询）
- 联调约定：契约 C6 验收测试（积分不变、不锁下载、UsageRecord settled、C 端 dashboard 不可见、讲稿非空页数对齐）
- §8 第 9/10 条（讲稿回报、多文档）是挡 P0 的两项；多文档 P0 用方向二（网关侧预合成单文档）过渡

## 待确认清单（PLAN §11）

对象存储选型（默认腾讯 COS）/ DSH 会话持久化 backend / 数字人、AI3D 正式产品名 / PPTCreator 方向一排期。
设计层面仍开放（销售开口前书面）：教材正文合规口径、试点校组织细节、内部报价模型、OpenMAIC spike 两周结论。

## 安全注意

- secret 只进 `/data/www/codelphi/gateway.env`，不进仓库、不进对话（本会话曾意外回显过一次 chandler secret，建议方便时轮换）
- 本地 MySQL root 密码出现在本文件纯属用户明确同意（本机环境）
