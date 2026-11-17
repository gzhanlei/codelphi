# CoDelphi

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/)

**English documentation: [README.md](README.md).**

**CoDelphi 把 GitHub 仓库变成一份可追溯的产品规格。** 连接仓库后，AI 自动提取功能清单与用户场景，每次 push 自动总结行为变化——每一条结论都附带可点击的源码证据，而不是凭空生成的摘要。

- 🔍 **证据可溯**：AI 只能引用本次实际读取的代码路径，未知路径会让分析直接失败——从机制上杜绝幻觉，而不是靠提示词约定。
- 🔄 **随代码演进**：GitHub App webhook 驱动，push 即自动分析；发布页优先展示功能与场景的前后行为差异。
- ✍️ **人机协作**：功能树、场景与产品概况支持手动编辑；人工来源的内容永远不会被自动分析覆盖。
- 🏃 **真实可用**：CoDelphi 在生产环境持续分析自身仓库等多个真实产品，本项目本身就是它的第一个分析对象。

**实时 Demo（免登录只读）：** https://codelphi.com/products/u-a8811be775/codelphi

**云服务：** https://codelphi.com

## CoDelphi Radar Skill

Radar 是一个独立 Skill：分析本地 Git 仓库或公开 GitHub 仓库，产出**单文件、可离线打开的 HTML 产品简报**——产品简介、核心能力、典型场景、完整功能规格与逐条源码证据。它不做持续分析、不写数据库；与主产品共享同一套 prompt、schema、证据校验和确定性合并，不维护第二套分析实现。

### 安装

在支持技能的 agent 宿主（Claude Code、Kimi Code 等）里，直接对它说：

```
安装 https://github.com/gzhanlei/codelphi/releases/latest/download/codelphi-radar.zip 这个 skill
```

宿主会下载 zip 并解压到自己的技能目录（Claude Code 为 `~/.claude/skills/codelphi-radar/`）。也可以[直接下载 zip](https://github.com/gzhanlei/codelphi/releases/latest/download/codelphi-radar.zip) 手动解压。（维护者发布方式：`npm run radar:package` 重建后把 `dist/codelphi-radar.zip` 挂到 GitHub Release 资产；`releases/latest/download` 固定指向最新一个。）

### 使用

安装后对宿主说：

```
用 codelphi radar skill 分析 https://github.com/owner/repo
```

目标也可以是本地仓库路径。宿主会运行 `prepare` 固定 commit 并切分工作单，用 `complete` 快路径并发完成，最后 `finalize` 生成 `radar.html`（默认写在工作目录的 `.radar-work/` 下）。

### 三步命令

```bash
node codelphi-radar/scripts/snapshot.cjs prepare /path/to/repo --workdir .radar-work --language zh-CN
CODELPHI_SKILL_HOST=claude-code node codelphi-radar/scripts/snapshot.cjs complete --workdir .radar-work --concurrency 4
node codelphi-radar/scripts/snapshot.cjs finalize --workdir .radar-work
```

`complete` 按序探测完成通道：standalone AI 配置（`--env-file` 或 `AI_API_KEY`/`AI_MODEL`）→ 宿主注入的显式桥（`CODELPHI_HOST_AI_BRIDGE_URL`/`TOKEN` 或 `CODELPHI_HOST_AI_COMMAND`/`CODELPHI_HOST_AI_ARGS_JSON`）→ 当前宿主自己的 headless CLI（用 `CODELPHI_SKILL_HOST` 标明宿主身份：`claude-code`、`codex`、`gemini`、`cursor`、`kimi`、`qwen`、`opencode`、`antigravity`——绝不跨厂商探测）。全部不可用时输出原因并回退为宿主逐个执行工作单。`--ref` 固定版本，重复 `--scope` 限定 monorepo 范围，`--language en` 生成英文报告。

### standalone 一条命令

没有 agent 宿主时，显式选择 standalone 模式（`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`，或 `--env-file`）：

```bash
npm run snapshot -- /path/to/repo --language zh-CN --output report.html
npm run snapshot -- https://github.com/owner/repo --ref main --language en --output report.html
```

### 边界

一次性理解工具：不做持续分析、release 跟踪、webhook 或轮询；不支持私有 GitHub 仓库、SSH URL、GitLab/Gitee/Gitea；只读 Git 对象，不把未提交文件混入分析。**功能与简介是未人工核实的 AI 候选**：证据可溯 ≠ 结论正确，覆盖装配率不是正确率。完整文档见 [docs/local-snapshot.md](docs/local-snapshot.md)。

## CoDelphi 都实现了什么

CoDelphi 持续分析自身仓库，所以最新、带证据的功能清单就是产品本身：

**直接看产品页：https://codelphi.com/products/u-a8811be775/codelphi** ——功能、场景、逐发布行为变化与知识健康，全部带可点击的源码证据。

## 技术栈

Next.js（App Router）· TypeScript · React · MySQL 8 · Vitest · OpenAI 兼容 LLM API

## 本地启动

### 1. 准备配置

```bash
cp .env.example .env
openssl rand -hex 32  # SESSION_SECRET
openssl rand -hex 32  # GITHUB_WEBHOOK_SECRET
```

至少填写：`DATABASE_URL`（腾讯云 MySQL `mysql://` URL，库名 `radar`）、`CHANDLER_CLIENT_ID` / `CHANDLER_CLIENT_SECRET`、`GITHUB_TOKEN`（对内部仓库只读）、`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`。可选：`AUTH_ALLOWED_EMAILS`（仅封闭部署的登录限制）、`PUBLIC_DEMO_SLUGS`（过渡兜底的 Demo 白名单，推荐用产品设置页开关）。`DATABASE_SSL=true` 为默认值；仅在 VPC 内网明确不需要 TLS 时设为 `false`。

### 2. 创建独立数据库和账号

由 MySQL 管理员执行（替换密码与网段，不要在聊天中提交真实密码）：

```sql
CREATE DATABASE radar CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'radar'@'%' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES, DROP
ON radar.* TO radar@'%';
FLUSH PRIVILEGES;
```

### 3. 初始化并启动

> 注意：`.env` 若指向生产数据库，本地 `next dev` 启动**不会**触发启动恢复与账务 sweep（development 默认跳过，见 `instrumentation.ts`）；确需本地联调这些链路时显式设置 `ALLOW_PROD_SIDE_EFFECTS=true`。

```bash
npm install
npm run db:create
npm run db:migrate
npm run db:seed
npm run dev
```

打开 `http://localhost:3000`，用 Chandler 登录。点击「添加产品」注册 GitHub `owner/repo` 与默认分支；保持「添加后立即分析」选中即可生成第一版规格。也可本地手动分析：`npm run analyze -- <产品-slug>`。

### 4. Chandler OAuth 与 GitHub App

在 `https://app.chandler.work/partner/apps` 创建应用（scope `openid profile email`，回调 `http://localhost:3000/auth/callback`）。

然后打开 `/integrations` 点「创建 CoDelphi GitHub App」——App 仅申请 `contents:read` 和 `metadata:read`；新 App 的 Manifest 同时声明 App 级 Webhook URL 与 `push` 事件，push 自动分析开箱即用。已有 App 通过「设置 Push 通知」一次性补配（GitHub 没有更新 App Webhook 的公开 REST API）：Payload URL 填 `https://<部署域名>/api/webhooks/github`，Secret 填服务器 `.env` 的 `GITHUB_WEBHOOK_SECRET`，并且 **Webhook 表单与事件订阅两个区域都要完成**——只填表单不订阅事件，push 不会有任何投递。

验证：App 设置 → Advanced → Recent Deliveries，对 ping 点 Redeliver 应返回 200；推一个 commit 应出现 202 投递并自动开始分析。

## 部署

生产部署使用持久运行的 Node.js 服务（推荐 Docker Compose，见 [docs/docker-migration-plan.md](docs/docker-migration-plan.md)），不要用请求结束即冻结的 Serverless——Webhook 与页面「立即分析」都依赖 Next.js `after()` 在响应后继续执行。

## 分析触发模式

分析管线全貌见 [docs/analysis-pipeline.md](docs/analysis-pipeline.md)。仓库接入后默认「每次 push 都立即分析」；高频仓库可在产品设置页切换为「每天低峰期一次」或「每 N 次推送 + 当天兜底」，控制每月分析单元（SAU）消耗。所有模式都会把自上次成功分析以来的全部提交合并进同一次分析。

## 让 AI 编程助手接入（MCP）

CoDelphi 提供 13 个 MCP 工具（12 只读 + 1 个反馈通道）：改文件前 `lookup_by_files` 反查改动会碰哪些功能与场景；`search_scenarios` 检索带源码证据的行为约定；push 后 `list_releases` / `get_release` 核对实际变化；`send_feedback` 上报账本与代码不符，由 AI 裁决管线自动核实处置。

1. 在 codelphi.com 设置页「MCP key 管理」创建组织级只读 key——连接向导直接生成所用客户端的 `mcpServers` 配置；公开页 <https://codelphi.com/mcp> 有完整指引（支持 MCP 自动发现与 OAuth 动态注册）。
2. 把配置写入你的 AI 编程助手。
3. 把 [docs/coding-agent-mcp.md](docs/coding-agent-mcp.md) 中的策略段贴进仓库 `AGENTS.md`，agent 在该仓库每次会话都会自觉执行账本工作流。

## 数据与安全边界

- 只保存 Chandler `sub`、邮箱、显示名和头像，不保存密码或 OAuth token；会话有效期 7 天。
- AI 只能引用本次读取的代码或 diff 文件；代码仅发送给配置的 AI 网关。
- GitHub 优先使用按仓库授权的 GitHub App Installation Token，服务端共享 PAT 仅作兼容回退。
- **已知边界**：路径守卫只防引用幻觉，不防语义幻觉——真实行号配错误解读照样通过校验。证据覆盖率不是结论正确性，输出应经人工核实后采纳。
