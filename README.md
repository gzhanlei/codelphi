# CoDelphi

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/)

**CoDelphi 把 GitHub 仓库变成一份可追溯的产品规格。** 连接仓库后，AI 自动提取功能清单与用户场景，每次 push 自动总结行为变化——每一条结论都附带可点击的源码证据，而不是凭空生成的摘要。

> CoDelphi turns a GitHub repository into a traceable product spec: AI-extracted features and scenarios, per-push behavior changes, every claim backed by source-code evidence.

- 🔍 **证据可溯**：AI 只能引用本次实际读取的代码路径，未知路径会让分析直接失败——从机制上杜绝幻觉，而不是靠提示词约定。
  🔍 **Traceable evidence**: the AI may only cite code paths actually read in the run; unknown paths fail the analysis outright — hallucination is ruled out by mechanism, not by prompt conventions.
- 🔄 **随代码演进**：GitHub App webhook 驱动，push 即自动分析；发布页优先展示功能与场景的前后行为差异，Commit 与 AI 摘要仅作证据补充。
  🔄 **Evolves with the code**: driven by GitHub App webhooks, analyzed automatically on push; release pages lead with before/after behavior diffs of features and scenarios, while commits and AI summaries are evidence supplements only.
- ✍️ **人机协作**：功能树、场景与产品概况支持手动编辑；标记为人工来源的内容永远不会被自动分析覆盖。
  ✍️ **Human-in-the-loop**: the feature tree, scenarios and product overview are manually editable; anything marked as human-authored is never overwritten by automated analysis.
- 🏃 **真实可用**：CoDelphi 在生产环境持续分析自身仓库等多个真实产品，本项目本身就是它的第一个分析对象。
  🏃 **Real-world proven**: CoDelphi continuously analyzes its own repository and several other real products in production; this project is its first analysis subject.

## 与本仓库实时同步的 Demo · Live Demo

https://codelphi.com/products/u-a8811be775/codelphi 无需注册登录也可只读查看。产品页地址带工作区前缀：`/products/{工作区slug}/{产品slug}`；旧的一段式地址 `/products/{slug}` 会自动重定向。Demo 由产品的「设置」页里的公开演示开关控制（数据库 `products.is_public_demo`；`PUBLIC_DEMO_SLUGS` 环境变量仍作过渡兜底）。

> Browse read-only without an account at https://codelphi.com/products/u-a8811be775/codelphi. Product pages are org-qualified: `/products/{org-slug}/{product-slug}`; the legacy single-segment `/products/{slug}` redirects automatically. The demo is controlled by the product's "public demo" switch in Settings (database column `products.is_public_demo`; the `PUBLIC_DEMO_SLUGS` env var remains a transitional fallback).

## CoDelphi Radar Skill 使用方法 · Using the CoDelphi Radar Skill

### 这是什么 · What it is

`codelphi-radar` 是随主仓库发布的独立 Skill：读取本地 Git 仓库或 GitHub 公开仓库的固定 commit，生成一份**可离线打开的单文件 HTML 产品简报**（产品简介、核心能力、典型场景、完整功能规格与逐条源码证据）。它不做持续分析、不写数据库；与主产品共享同一套 prompt、schema、证据校验和确定性合并，不维护第二套分析实现。

> `codelphi-radar` is a standalone skill shipped alongside the main repo: it reads a fixed commit of a local Git repository or a public GitHub repository and produces a **single-file, offline-openable HTML product brief** (product description, core capabilities, typical scenarios, the full feature spec and per-claim source evidence). It does no continuous analysis and writes no database; it shares the same prompts, schema, evidence validation and deterministic merge as the main product — there is no second analysis implementation.

安装页与下载：https://codelphi.com/skills/codelphi-radar ｜ 详情文档：[docs/local-snapshot.md](docs/local-snapshot.md)

> Install page and download: https://codelphi.com/skills/codelphi-radar ｜ Full docs: [docs/local-snapshot.md](docs/local-snapshot.md)

### 安装 · Install

```bash
npm run radar:skill    # 构建到 dist/codelphi-radar/（SKILL.md + scripts/snapshot.cjs）
npm run radar:package  # 同时产出 dist/codelphi-radar.zip
```

把 `dist/codelphi-radar/` 放进你的 agent 宿主的 skill 目录（例如 Claude Code 的 `~/.claude/skills/codelphi-radar/`）。

> Drop `dist/codelphi-radar/` into your agent host's skill directory (e.g. `~/.claude/skills/codelphi-radar/` for Claude Code). The bundle is self-contained: no CoDelphi source, root `node_modules`, Next.js or MySQL needed.

### 三步用法（宿主原生，优先） · Three-step usage (host-native, preferred)

```bash
# 1) 准备工作单（固定 commit、切分分区；不需要任何 AI 配置）
node <skill目录>/scripts/snapshot.cjs prepare /path/to/repo --workdir .radar-work --language zh-CN

# 2) 完成工作单——先试 complete 快路径（一发一分区直调，可并发）
node <skill目录>/scripts/snapshot.cjs complete --workdir .radar-work --concurrency 4

# 3) 生成报告
node <skill目录>/scripts/snapshot.cjs finalize --workdir .radar-work
# → .radar-work/radar.html
```

`complete` 自动探测完成通道，按序尝试：

1. **standalone AI 配置**：`--env-file` 或环境里已有 `AI_API_KEY` + `AI_MODEL`（OpenAI 兼容网关）；
2. **宿主显式桥**：宿主注入 `CODELPHI_HOST_AI_BRIDGE_URL`/`CODELPHI_HOST_AI_BRIDGE_TOKEN`（HTTP 桥）或 `CODELPHI_HOST_AI_COMMAND` + `CODELPHI_HOST_AI_ARGS_JSON`（stdin 收 `{messages}` 的桥接命令）；
3. **宿主 headless CLI 自动探测**：仅当 `CODELPHI_SKILL_HOST` 标明当前宿主且该宿主自己的 CLI 在 PATH 上——`claude-code`→`claude -p`、`codex`→`codex exec`、`gemini`→`gemini -p`、`cursor`→`cursor-agent -p`、`kimi`→`kimi -p`、`qwen`→`qwen -p`、`opencode`→`opencode run`、`antigravity`→`agy -p`。**只匹配当前宿主自己的 CLI，绝不跨厂商探测**（避免意外消耗其他订阅额度）。

实测参考：一发一分区直调约 41k token / 约 20 秒；对比在宿主会话内用子代理逐个执行工单（每分区 120 万+ token、5–10 分钟）。三级通道都不可用时，`complete` 会输出全部探测原因并退出，此时回退到 agent 执行——对每个 `work-orders/<id>.json` 运行 `show --workdir <目录> --partition <id>`，用宿主当前模型执行返回的 system/user 消息，把 JSON 写入 `results/<id>.json`（详见 `SKILL.md`）。

> `complete` detects a completion backend in order:
>
> 1. **Standalone AI config**: `--env-file`, or `AI_API_KEY` + `AI_MODEL` already set (OpenAI-compatible gateway);
> 2. **Host-injected bridge**: `CODELPHI_HOST_AI_BRIDGE_URL`/`CODELPHI_HOST_AI_BRIDGE_TOKEN` (HTTP) or `CODELPHI_HOST_AI_COMMAND` + `CODELPHI_HOST_AI_ARGS_JSON` (a command fed `{messages}` via stdin);
> 3. **Host headless CLI autodetect**: enabled only when `CODELPHI_SKILL_HOST` names the current host and that host's own CLI is on PATH — `claude-code`→`claude -p`, `codex`→`codex exec`, `gemini`→`gemini -p`, `cursor`→`cursor-agent -p`, `kimi`→`kimi -p`, `qwen`→`qwen -p`, `opencode`→`opencode run`, `antigravity`→`agy -p`. **Only the current host's own CLI is probed, never another vendor's** (no surprise spend on other subscriptions).
>
> Measured reference: one direct completion per partition ≈ 41k tokens / ~20s, versus executing work orders through in-session subagents (1.2M+ tokens, 5–10 minutes per partition). When no backend exists, `complete` prints all probe reasons and exits; fall back to the agent flow — run `show --workdir <dir> --partition <id>` for each work order, execute the returned system/user messages with the host's current model, and write the JSON to `results/<id>.json` (see `SKILL.md`).

`prepare` 还支持 `--ref <commit|branch|tag>` 固定指定版本，以及重复 `--scope <path>` 限定 monorepo 分析范围。已完成的结果在重新 prepare/complete 时保留，断点可续。

> `prepare` also accepts `--ref <commit|branch|tag>` to pin a revision and repeatable `--scope <path>` to limit monorepo scope. Completed results are preserved across prepare/complete runs, so interrupted runs resume in place.

### standalone 一条命令 · One-shot standalone CLI

```bash
# 需 AI_BASE_URL / AI_API_KEY / AI_MODEL（或显式 --env-file）
npm run snapshot -- /path/to/repo --language zh-CN --output report.html
npm run snapshot -- https://github.com/owner/repo --ref main --language en --output report.html
```

`--env-file` 只读取 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`，不加载其中的 `DATABASE_URL` 等其他变量。只有用户显式选择 standalone 时才使用独立配置，宿主原生模式不会静默回退。

> `--env-file` reads only `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL`; other variables (e.g. `DATABASE_URL`) in the same file are ignored. Standalone is used only when explicitly chosen — host-native mode never silently falls back to it.

### 边界 · Boundaries

一次性理解工具：不做持续分析、release 跟踪、webhook 或轮询；不支持私有 GitHub 仓库、SSH URL、GitLab/Gitee/Gitea；只读 Git 对象，不把未提交或未跟踪文件混入分析。**功能与简介是未人工核实的 AI 候选**：证据可溯 ≠ 结论正确，覆盖装配率不是正确率。

> A one-shot understanding tool: no continuous analysis, release tracking, webhooks or polling; no private GitHub repos, SSH URLs, GitLab/Gitee/Gitea; it reads Git objects only and never mixes uncommitted or untracked files into the analysis. **Features and summaries are unverified AI candidates**: traceable evidence ≠ correct conclusions, and assembled-coverage ratio is not accuracy.

## 懒得自托管，用我搭好的云服务 · Or just use the hosted service

https://codelphi.com

## 技术栈 · Tech stack

Next.js（App Router）· TypeScript · React · MySQL 8 · Vitest · OpenAI 兼容 LLM API

> Next.js (App Router) · TypeScript · React · MySQL 8 · Vitest · OpenAI-compatible LLM API

## 已实现 · Implemented

- Chandler OAuth 授权码 + PKCE（S256）登录、HttpOnly 会话、个人工作区自动创建；共享工作区按成员与邀请授权。
  Chandler OAuth authorization code + PKCE (S256) login, HttpOnly sessions, automatic personal workspaces; shared workspaces authorized by membership and invitations.
- GitHub App Manifest 创建与安装、只读 Installation Token、AES-GCM 凭据加密、连接检查与本地断开。
  GitHub App manifest creation and installation, read-only installation tokens, AES-GCM credential encryption, connection checks and local disconnect.
- Integrations 页面与添加产品时的 GitHub App/PAT 凭据选择；无凭据时提供配置引导。
  Integrations page and GitHub App/PAT credential selection when adding products, with setup guidance when none exist.
- Gitee、GitLab、Gitea 的工作区级连接配置与服务端验证；目前添加产品和代码分析仍仅支持 GitHub。
  Workspace-level connections and server-side verification for Gitee, GitLab and Gitea; product onboarding and code analysis remain GitHub-only for now.
- 代码平台 Provider 抽象：注册、分支与变更读取、源码后端及仓库链接统一通过 adapter；当前仅注册 GitHub 分析实现。
  A provider abstraction for code platforms: registration, branch and change reads, source backends and repo links all go through adapters; only the GitHub analysis implementation is registered today.
- 自有 Git 服务使用 HTTPS 与 `REPOSITORY_HOST_ALLOWLIST` 精确主机/端口白名单；删除令牌连接会清除保存的凭据。
  Self-hosted Git services use HTTPS with an exact host/port allowlist (`REPOSITORY_HOST_ALLOWLIST`); deleting a token connection clears stored credentials.
- 两级功能树、功能与场景 CRUD、人工来源保护、软删除 tombstone 和父子层级事务保护。
  Two-level feature tree, feature/scenario CRUD, human-source protection, soft-delete tombstones and parent/child transaction guards.
- 场景分类/全文筛选、列表与表格视图，以及基于场景推导的 SVG 用户流程图。
  Scenario category/full-text filtering, list and table views, and SVG user-flow diagrams derived from scenarios.
- GitHub push Webhook HMAC-SHA256 验签及默认分支过滤。
  GitHub push webhook HMAC-SHA256 verification and default-branch filtering.
- 手动分析与 push 自动分析；每次分析记录运行状态和错误。
  Manual and push-triggered analysis; every run records status and errors.
- 不可变 Spec Version 快照，合并人工功能与场景，并计算确定性的功能/场景行为 Diff。
  Immutable spec-version snapshots merging human and generated content, with deterministic feature/scenario behavior diffs.
- 发布页优先展示行为变化及前后差异，Commit 与 AI 摘要仅作为证据和补充。
  Release pages lead with behavior changes and before/after diffs; commits and AI summaries are evidence supplements only.
- 发布稿（客户向 release notes）：勾选要宣布的功能 → 生成合并全部已选变化的草稿（可回退原文），人工发布后生成公开只读页（可复制链接 / Markdown 导出），每块锚定 spec_change 并附证据路径；生成与发布都是用户主动行为。
  Customer-facing release notes: pick features to announce → generate a draft merging all selected changes (per-block AI polish with original-text fallback), publish manually to a public read-only page (copyable link / Markdown export); every block anchors to a spec_change with evidence paths. Both generation and publishing are explicit user actions.
- 周期行为摘要（Digest）：滚动 7 天窗口自动汇总，按 Highlight 分桶给 support / sales / marketing 视角，经 Slack/Webhook/邮件分发；无变化的周不发送。
  Periodic behavior digests: rolling 7-day windows bucketed for support / sales / marketing, delivered via Slack/Webhook/email; silent weeks are not sent.
- 功能行为变迁史与关联功能：按发布分组的行为变化时间线，以及基于共享证据文件的确定性功能连接（每条带依据，不宣称语义依赖）。
  Feature change history and related features: per-release timelines plus deterministic feature connections based on shared evidence files (each link carries its basis; no semantic dependency claims).
- 知识健康视图：漂移条目、核实覆盖、回归四态、编辑者维护分布——只做事实统计，无综合健康分。
  Knowledge-health view: drift entries, verification coverage, regression states, editor maintenance distribution — facts only, no composite score.
- 公开变更日志：`/share/changelog/{org}/{product}` 聚合全部已发布发布稿。
  Public changelog: `/share/changelog/{org}/{product}` aggregates all published release notes.
- MCP 工具面：12 个只读工具 + send_feedback 反馈通道，供 Claude Code、Codex、ChatGPT 等 AI 编程助手读取规格、反查影响面与 push 后对账；组织级 MCP key 管理与连接向导在设置页。
  MCP tool surface: 12 read-only tools plus a send_feedback channel for AI coding assistants (Claude Code, Codex, ChatGPT, …) to read specs, query blast radius and reconcile after pushes; org-level MCP key management and a connection wizard live in Settings.
- LLM 结构化输出校验、代码证据路径校验。
  LLM structured-output validation and code-evidence path validation.
- MySQL 版本化迁移、CoDelphi 自产品注册脚本。
  Versioned MySQL migrations and a self-registration script for CoDelphi as its own product.
- 自动分析仅更新 generated 内容，不覆盖 manual 功能或场景；生成功能名作为稳定关联键不可直接修改。
  Automated analysis updates generated content only; manual features/scenarios are never overwritten, and generated feature names act as stable keys that cannot be edited directly.
- 响应式中文界面（界面语言支持中英切换）。
  Responsive UI (Chinese/English interface language toggle).

## 本地一次性产品快照 · Local one-shot product snapshot

除 Skill 分发形态外，仓库内可直接以 CLI 运行同一条管线：读取本地 Git 仓库或 GitHub 公开仓库的固定 commit，生成一份可离线打开、可独立分享的产品现状 HTML。它不创建 MySQL 记录，不做持续分析。宿主原生模式不需要额外模型 API、桥接或凭据；宿主未开放接口时明确报错，只有用户显式选择 standalone 才使用独立 AI 配置。各宿主支持状态以文档为准，不宣称未经测试的全宿主兼容。

> Besides the distributable skill, the same pipeline runs in-repo as a CLI: pin a commit of a local or public GitHub repository and produce an offline-openable, independently shareable HTML snapshot. No MySQL records, no continuous analysis. Host-native mode needs no extra model API, bridge or credentials; when the host exposes none, the CLI errors clearly, and standalone AI config is used only when explicitly selected. Host support status follows the docs — no untested "works everywhere" claims.

详见 [本地产品现状快照](docs/local-snapshot.md)。

> See [local product snapshot docs](docs/local-snapshot.md) for details.

## 本地启动 · Local setup

### 1. 准备配置 · 1. Prepare configuration

```bash
cp .env.example .env
openssl rand -hex 32  # 填入 SESSION_SECRET / fill into SESSION_SECRET
openssl rand -hex 32  # 填入 GITHUB_WEBHOOK_SECRET / fill into GITHUB_WEBHOOK_SECRET
```

编辑 `.env`，至少填写（数据库名改为你希望的）：

- `DATABASE_URL`：腾讯云 MySQL 的 `mysql://` URL，数据库名为 `radar`。
- `CHANDLER_CLIENT_ID` / `CHANDLER_CLIENT_SECRET`。
- `AUTH_ALLOWED_EMAILS`（可选）：特殊封闭部署的登录限制，英文逗号分隔；留空允许所有有效 Chandler 用户，不用于工作区成员管理。
- `PUBLIC_DEMO_SLUGS`（可选，过渡兜底）：公开只读 Demo 的产品 slug 白名单。推荐改用产品「设置」页的公开演示开关（写入数据库）；此变量仍生效，便于未迁移的部署。匿名访客可浏览该产品页面，所有保存/分析操作会弹出 Demo 提示而不发请求。
- `GITHUB_TOKEN`：对内部仓库具有只读权限的 Token。
- `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`：LLMGateway 配置。

`DATABASE_SSL=true` 为默认值；只有在 VPC 内网且明确不需要 TLS 时才设为 `false`。密码等配置不会写入 Git。

> Edit `.env`, filling at least (rename the database as you like):
>
> - `DATABASE_URL`: a Tencent Cloud MySQL `mysql://` URL with database name `radar`.
> - `CHANDLER_CLIENT_ID` / `CHANDLER_CLIENT_SECRET`.
> - `AUTH_ALLOWED_EMAILS` (optional): login restriction for closed deployments, comma-separated; empty allows all valid Chandler users — it is not used for workspace membership.
> - `PUBLIC_DEMO_SLUGS` (optional, transitional fallback): slug allowlist for public read-only demos. Prefer the per-product "public demo" switch in Settings (stored in the database); the variable still works for unmigrated deployments. Anonymous visitors can browse the demo product; every save/analyze action shows a demo notice instead of sending a request.
> - `GITHUB_TOKEN`: a token with read access to the internal repositories.
> - `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`: LLM gateway configuration.
>
> `DATABASE_SSL=true` is the default; set it to `false` only inside a VPC where TLS is explicitly unnecessary. Secrets are never committed to Git.

### 2. 创建独立数据库和账号 · 2. Create a dedicated database and account

由 MySQL 管理员在**现有腾讯云实例**中执行（替换数据库名、密码和网段，不要在聊天中提交真实密码）：

```sql
CREATE DATABASE radar CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'radar'@'%' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES, DROP
ON radar.* TO radar@'%';
FLUSH PRIVILEGES;
```

CoDelphi 不使用 Chandler 的业务表。生产环境建议按实际应用网段收紧账号 Host，并定期轮换密码。

> Run as the MySQL administrator on the **existing Tencent Cloud instance** (replace database name, password and network ranges; never paste real passwords into chats). CoDelphi does not touch Chandler's business tables. In production, tighten the account host to your application's subnets and rotate passwords regularly.

### 3. 初始化并启动 · 3. Initialize and start

> 注意：`.env` 若指向生产数据库，本地 `next dev` 启动**不会**触发启动恢复与账务 sweep（development 默认跳过，见 `instrumentation.ts`）；确需本地联调这些链路时显式设置 `ALLOW_PROD_SIDE_EFFECTS=true`。
>
> Note: if `.env` points at the production database, local `next dev` **will not** trigger startup recovery or billing sweeps (skipped in development by default, see `instrumentation.ts`); set `ALLOW_PROD_SIDE_EFFECTS=true` explicitly to exercise those paths locally.

```bash
npm install
npm run db:create
npm run db:migrate
npm run db:seed
npm run dev
```

打开 `http://localhost:3000`，点击“使用 Chandler 登录”。

> Open `http://localhost:3000` and click "Sign in with Chandler".

### 添加其他产品 · Adding other products

登录后点击产品总览右上角的“添加产品”，填写产品名称、URL Slug、GitHub `owner/repo` 和默认分支。CoDelphi 会先验证仓库读取权限，再写入产品与仓库记录；保持“添加后立即分析”选中即可生成第一版规格。

> After signing in, click "Add product" at the top right of the workspace overview and fill in the product name, URL slug, GitHub `owner/repo` and default branch. CoDelphi verifies repository read access before writing the product and repository records; keep "analyze immediately after adding" selected to produce the first spec.

也可以在本地对已经注册的产品手动执行：

```bash
npm run analyze -- <产品-slug>
```

当前阶段每个产品接入一个主仓库。GitHub Token 必须对新增仓库具有读取权限。**边界说明**：这是产品粒度约定，不是隐藏限制——多服务拆分（polyrepo）的产品可按服务各建产品空间，工作区总览聚合发布动态；跨仓库的影响传播（如 API 契约变更波及下游服务）暂不支持，出现真实需求再评估。

> You can also run analysis manually for an already-registered product with `npm run analyze -- <product-slug>`. Each product currently connects one primary repository; the GitHub token must have read access to newly added repos. **Boundary note**: this is a product-granularity convention, not a hidden limitation — polyrepo products can create one product space per service with the workspace overview aggregating releases; cross-repository impact propagation (e.g. API contract changes hitting downstream services) is not supported yet and will be evaluated when real demand appears.

### 4. 配置 Chandler OAuth · 4. Configure Chandler OAuth

在 `https://app.chandler.work/partner/apps` 创建 CoDelphi 应用，scope 为 `openid profile email`，登记回调 `http://localhost:3000/auth/callback`（部署到互联网服务器时改为你的域名和端口）。有效 Chandler 用户默认可登录并自动获得个人工作区；共享工作区通过成员与邀请授权，只有特殊封闭部署才需要 `AUTH_ALLOWED_EMAILS`。

> Create the CoDelphi app at `https://app.chandler.work/partner/apps` with scope `openid profile email` and register the callback `http://localhost:3000/auth/callback` (replace with your domain and port when deploying to a public server). Valid Chandler users can sign in by default and get a personal workspace automatically; shared workspaces are authorized by membership and invitations, and only closed deployments need `AUTH_ALLOWED_EMAILS`.

### 使用 GitHub App（推荐） · Using the GitHub App (recommended)

打开 `/integrations`，点击“创建 CoDelphi GitHub App”，在 GitHub 官方页面完成创建，然后点击“添加安装”。App 仅申请 `contents:read` 和 `metadata:read`；新 App 的 Manifest 同时声明 App 级 Webhook URL 与 `push` 事件，安装后所选仓库的默认分支更新会自动通知 CoDelphi。已有 App 可点击“设置 Push 通知”跳转 GitHub 设置，一次性补设相同 URL、Webhook Secret 和事件；GitHub 没有更新 App Webhook 的公开 REST API，因此旧 App 需要这一次手工操作。

> Open `/integrations`, click "Create CoDelphi GitHub App", finish creation on GitHub's official page, then click "Add installation". The app requests only `contents:read` and `metadata:read`; new apps declare an app-level webhook URL and the `push` event in their manifest, so default-branch updates on selected repos notify CoDelphi automatically. Existing apps can click "Set up push notifications" to jump to GitHub settings and backfill the same URL, webhook secret and event in one pass — GitHub exposes no REST API for updating app webhooks, so older apps need this one-time manual step.

安装时可选择全部仓库或指定仓库。CoDelphi 将 App 私钥、Client Secret 和 Webhook Secret 使用 AES-256-GCM 加密后存入 MySQL，仅在服务端内存中解密换取 Installation Token 或验证 Webhook。页面支持重新检查连接和本地断开；断开不会卸载 GitHub App，也不会删除已有规格。添加产品时选择对应的 GitHub App 安装即可；现有 `GITHUB_TOKEN` 仅作为兼容回退。

> Choose all or selected repositories during installation. CoDelphi stores the app private key, client secret and webhook secret AES-256-GCM-encrypted in MySQL, decrypting only in server memory to exchange installation tokens or verify webhooks. The page supports re-checking connections and local disconnect; disconnecting neither uninstalls the GitHub App nor deletes existing specs. Select the matching GitHub App installation when adding products; a pre-existing `GITHUB_TOKEN` serves only as a compatibility fallback.

### 5. 配置 GitHub Webhook · 5. Configure the GitHub webhook

新 GitHub App 会自动配置 App 级 Webhook；已有 App 在 `/integrations` 点击“设置 Push 通知”，在 GitHub App 设置中一次性填写相同 URL、将 Webhook Secret 设为部署环境的 `GITHUB_WEBHOOK_SECRET`，并订阅 `push`。接收端同时接受 App Webhook Secret 与旧的 `GITHUB_WEBHOOK_SECRET`，因此迁移期间已有的逐仓 Webhook 不会中断。

> New GitHub Apps get an app-level webhook automatically; existing apps should click "Set up push notifications" in `/integrations` and fill the same URL, set the webhook secret to the deployment's `GITHUB_WEBHOOK_SECRET`, and subscribe to `push`. The receiver accepts both the app webhook secret and the legacy `GITHUB_WEBHOOK_SECRET`, so per-repo webhooks keep working during migration.

**旧 App 迁移（一次性手工操作）**：GitHub 没有更新 App Webhook 的公开 REST API，上线前创建的 App 需在 GitHub 网页补配，注意 URL/Secret 和事件订阅是**两个独立的设置区域**：

1. **Webhook**（App 设置 → Webhook 标签）：勾选 Active，Payload URL 填 `https://<部署域名>/api/webhooks/github`，Webhook secret 填服务器 `.env` 中的 `GITHUB_WEBHOOK_SECRET`（GitHub 不回显已保存的值，核对只能重新粘贴）。
2. **事件订阅**（App 设置 → Permissions & events → Subscribe to events）：勾选 **Push** 并保存——只填 Webhook 表单不会订阅事件，push 不会有任何投递。
3. **验证**：App 设置 → Advanced → Recent Deliveries：保存 secret 后对 ping 点 Redeliver 应返回 200；推送一个 commit 应出现一条 202 投递，产品页自动开始分析。

排错速查：**401 invalid_signature** = GitHub 端 Secret 与服务器不一致，重新粘贴；**push 后无投递记录** = 事件未订阅；**修改 Secret 后没有自动 ping** = GitHub 不重发事件，需手动 Redeliver。

不使用 App 级通知时，仍可在单个仓库的 Webhook 设置中手工填写 `Payload URL: https://<域名>/api/webhooks/github`、`Content type: application/json`、`Secret: 与 GITHUB_WEBHOOK_SECRET 相同`、`Events: Push events`。

> **Legacy app migration (one-time manual step)**: GitHub exposes no REST API for updating app webhooks, so apps created before this feature need a one-time web-UI backfill across **two separate settings areas**:
>
> 1. **Webhook** (App settings → Webhook tab): enable Active, set the payload URL to `https://<your-domain>/api/webhooks/github`, and paste the server's `GITHUB_WEBHOOK_SECRET` (GitHub never shows saved values; verification means re-pasting).
> 2. **Event subscription** (App settings → Permissions & events → Subscribe to events): check **Push** and save — filling only the webhook form subscribes to nothing, so pushes deliver nowhere.
> 3. **Verify** (App settings → Advanced → Recent Deliveries): redelivering the ping should return 200 after saving the secret; pushing a commit should produce a 202 delivery and start an analysis on the product page.
>
> Troubleshooting: **401 invalid_signature** = secret mismatch between GitHub and the server, re-paste it; **no deliveries after a push** = the event is not subscribed; **no auto-ping after changing the secret** = GitHub does not resend events, redeliver manually.
>
> Without app-level notifications you can still configure a per-repo webhook manually with payload URL `https://<domain>/api/webhooks/github`, content type `application/json`, the same secret as `GITHUB_WEBHOOK_SECRET`, and push events only.

#### PR 预演权限升级（一次性操作） · PR preview permission upgrade (one-time)

PR 预演（`pull_request` 事件触发，在 PR 中评论受影响的规格并挂 `codelphi/behavior-preview` 检查）需要 App 具备写评论与写 Checks 权限。新装的 App 已在 Manifest 中声明 `pull_requests: write`、`checks: write` 与 `pull_request` 事件；**已有 App** 需要在 GitHub 网页补配：把 Pull requests 与 Checks 提升为 **Read and write**、勾选 **Pull request** 事件订阅、安装方重新批准权限。服务器开关 `PR_PREVIEW_ENABLED` **默认开启**，需要关闭时设为 `false` 并重启服务。权限升级期间预演失败只记日志并尝试把检查挂为 neutral，不影响 push 分析主链路。

验证：在一个已注册产品的仓库开测试 PR 改动某功能的证据文件，PR 应出现「CoDelphi 规格预演」评论和 `codelphi/behavior-preview` 检查；追加 commit 后同一评论被更新而非新建。

**检查语义与阻断（可选，由仓库自选）**：检查是**完成门禁，不是正确性门禁**——预演生成成功（含未命中规格索引）为 `success`，预演自身失败（权限/网络）为 `neutral`。是否合并由人工判断；仓库如需强制「合并前预演必须生成」，在分支保护规则里添加 `codelphi/behavior-preview`；CoDelphi 从不强制任何仓库开启阻断。回滚：把 `PR_PREVIEW_ENABLED` 设为 `false` 重启即可，权限可以保留。

> PR previews (triggered by `pull_request`, commenting the affected spec on the PR and attaching a `codelphi/behavior-preview` check) need comment- and check-write permissions. Newly installed apps already declare `pull_requests: write`, `checks: write` and the `pull_request` event; **existing apps** must backfill via the GitHub UI: raise Pull requests and Checks to **Read and write**, subscribe to the **Pull request** event, and have installers re-approve permissions. The server switch `PR_PREVIEW_ENABLED` is **on by default**; set it to `false` and restart to disable. During permission upgrades, preview failures are logged and the check is attached as neutral, leaving the push-analysis path untouched.
>
> Verify by opening a test PR that touches an evidence file of a registered feature: the PR should show a "CoDelphi spec preview" comment and a `codelphi/behavior-preview` check; a follow-up commit updates the same comment instead of creating a new one.
>
> **Check semantics and blocking (optional, per-repository choice)**: the check is a **completion gate, not a correctness gate** — a generated preview (including a miss against the spec index) is `success`, while a preview failure (permissions/network) is `neutral`. Merging stays a human decision; repositories that want to require a generated preview before merging can add `codelphi/behavior-preview` to branch protection — CoDelphi never forces blocking on anyone. Rollback: set `PR_PREVIEW_ENABLED=false` and restart; permissions may stay.

本地不需要 Webhook 即可验证分析：`npm run analyze -- radar`。Webhook 和页面上的“立即分析”都通过 Next.js `after()` 在响应后执行任务，因此生产部署应使用持久运行的 Node.js 服务，而不是请求结束即冻结的 Serverless 平台。

> Verify analysis locally without webhooks via `npm run analyze -- radar`. Both webhooks and the in-page "analyze now" execute through Next.js `after()` after the response, so production should run a persistent Node.js service rather than a serverless platform that freezes after the request.

## 数据与安全边界 · Data and security boundaries

- CoDelphi 只保存 Chandler `sub`、邮箱、显示名和头像；不保存 Chandler 密码或 OAuth token。每次会话有效期 7 天，过期后重新通过 Chandler 登录。
  CoDelphi stores only the Chandler `sub`, email, display name and avatar — never Chandler passwords or OAuth tokens. Sessions last 7 days and re-login is required afterwards.
- AI 只能引用本次读取的代码或 diff 文件，未知证据路径会使分析失败。代码仅发送给配置的 AI 网关；应确保 LLMGateway 及其上游符合内部代码保密要求。
  The AI may only cite code or diff files read in the run; unknown evidence paths fail the analysis. Code is sent only to the configured AI gateway — ensure the gateway and its upstream meet your code-confidentiality requirements.
- GitHub 优先使用按仓库授权的 GitHub App Installation Token，服务端共享 PAT 仅作兼容回退。
  GitHub access prefers per-repo GitHub App installation tokens; the server-wide PAT is a compatibility fallback only.
- 每次 push 当前采用小仓库全量规格重建 + 本次 diff 分析；大仓库的增量索引留待后续版本。
  Each push currently rebuilds the full spec for small repos plus a diff analysis; incremental indexing for large repositories is left to a later version.

**已知边界**：路径守卫只防引用幻觉，不防语义幻觉——真实存在的行号配一段错误解读，照样通过校验。Spec 版本号、证据文件数、可点击行号呈现的是证据覆盖率，不是结论正确性。本产品不判断「做对了没有」，输出应经人工核实后采纳。

> **Known limitation**: path guards prevent citation hallucination, not semantic hallucination — a real line number paired with a wrong interpretation still passes validation. Spec version numbers, evidence file counts and clickable line numbers express evidence coverage, not conclusion correctness. This product does not judge "was it built right"; treat its output as unverified until human review.

## 常用检查 · Common checks

```bash
npm run typecheck
npm test
npm run build
```

## 部署 · Deployment

生产部署应使用持久运行的 Node.js 服务（例如 systemd 管理的 `next start`，前端经 Nginx 反代），而不是请求结束即冻结的 Serverless 平台——Webhook 和页面上的“立即分析”都依赖 Next.js `after()` 在响应后继续执行任务。

> Run production on a persistent Node.js service (e.g. `next start` under systemd behind an Nginx reverse proxy), not a serverless platform that freezes after the response — webhooks and in-page "analyze now" both rely on Next.js `after()` continuing past the response.

发布流程参考：

```bash
# 本地：验证后推送 / Local: verify, then push
npm run typecheck && npm test && npm run build
git push origin main

# 服务器：拉取、构建、重启 / Server: pull, build, restart
git pull --ff-only origin main
npm install   # 依赖变更时 / when dependencies changed
npm run build
systemctl restart codelphi.service
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3008/login
```

说明：服务器建议通过只读的 GitHub deploy key 拉取代码；数据库迁移未纳入部署流程，schema 变更需在服务器上手动执行 `npm run db:migrate`；Explainer 导出需要 Chrome/Chromium（常规产品分析不依赖它），安装 `chromium` 后 Archify 运行时会自动发现标准路径下的可执行文件，也可用 `ARCHIFY_CHROME` 显式指定。

> Notes: pull code with a read-only GitHub deploy key; database migrations are not part of the deploy pipeline — run `npm run db:migrate` manually on the server for schema changes; explainer exports need Chrome/Chromium (regular product analysis does not) — after installing `chromium`, the Archify runtime discovers the binary at standard paths, or point `ARCHIFY_CHROME` at it explicitly.

## 分析触发模式 · Analysis trigger modes

分析管线全貌（分区装配、行为面枚举、韧性层、一致性核验、成本特征与运维旋钮）详见 [docs/analysis-pipeline.md](docs/analysis-pipeline.md)。

仓库接入后默认「每次 push 都立即分析」。高频仓库可在产品设置页切换为「每天低峰期一次」或「每 N 次推送 + 当天兜底」，以控制每月分析单元（SAU）消耗；所有模式都会把自上次成功分析以来的全部提交合并进同一次分析。

> The full analysis pipeline (partition assembly, behavior-surface enumeration, resilience layers, consistency checks, cost profile and operational knobs) is documented in [docs/analysis-pipeline.md](docs/analysis-pipeline.md).
>
> New repositories default to "analyze on every push". High-frequency repos can switch to "once per day off-peak" or "every N pushes plus an end-of-day catch-up" in product settings to control monthly analysis-unit (SAU) spend; every mode merges all commits since the last successful analysis into one run.

## 让 AI 编程助手接入（MCP） · Connect AI coding assistants (MCP)

CoDelphi 提供 13 个 MCP 工具（12 只读 + 1 个反馈通道），供 Claude Code、Codex、ChatGPT 等 AI 编程助手在整个开发周期使用：改文件前 `lookup_by_files` 反查改动会碰哪些功能与场景，理解既有行为用 `search_scenarios` 检索带源码证据的行为约定，push 后用 `list_releases` / `get_release` 核对「这次实际改变了什么」，发现账本与代码不符用 `send_feedback` 上报、由 AI 裁决管线自动核实处置（确认缺陷即触发修复性重建，误报驳回）。

> CoDelphi exposes 13 MCP tools (12 read-only + 1 feedback channel) for AI coding assistants such as Claude Code, Codex and ChatGPT to use across the development cycle: before editing, `lookup_by_files` finds which features/scenarios cite the files you plan to touch; to understand existing behavior, `search_scenarios` retrieves behavior contracts with source evidence; after a push, `list_releases` / `get_release` verify "what actually changed"; and `send_feedback` reports ledger/code mismatches to an AI adjudication pipeline (confirmed defects trigger restorative rebuilds; false reports are dismissed).

接入三步：

1. 在 codelphi.com 的设置页「MCP key 管理」创建组织级只读 key——连接向导会直接生成你所用客户端的 `mcpServers` 配置；公开页 <https://codelphi.com/mcp> 有完整连接指引（支持 MCP 自动发现与 OAuth 动态注册）。
2. 把该配置写入你的 AI 编程助手（Claude Code、Codex CLI、ChatGPT 连接器等均可识别标准 `mcpServers` JSON）。
3. 把下面的策略段贴进仓库根目录的 `AGENTS.md`（或 `CLAUDE.md`）；也可以用 /mcp 页提供的用户级常驻指令段一次覆盖你所有仓库。agent 在该仓库的每次会话都会自觉执行：

```markdown
## 行为账本（CoDelphi）

本仓库已接入 CoDelphi 行为账本（MCP 服务名通常为 codelphi；产品 slug 用 list_projects 按 git remote 匹配，拿不准问用户）。编码周期内自觉执行：

- 动手改文件前：lookup_by_files 反查这些文件是哪些功能/场景的证据；结果为空且覆盖率低时，明说「账本未覆盖，影响面未知」。
- 需要理解既有行为时：search_scenarios 检索规格原文（带 stableKey 与证据行号），不要只靠读代码猜约定。
- push 后：list_releases 找到本次 sha 对应的发布，get_release 核对变化清单与本次意图一致；计划外变化回查并向用户报告。
- 账本与代码不符：send_feedback 上报，AI 裁决管线自动核实处置。账本只读；「没搜到 ≠ 不存在」。
```

工具语义、红线与完整工作流配方见 [docs/coding-agent-mcp.md](docs/coding-agent-mcp.md)。

> Three steps to connect:
>
> 1. Create an org-level read-only key under "MCP key management" in codelphi.com settings — the connection wizard emits a ready-made `mcpServers` config for your client; the public page <https://codelphi.com/mcp> has the full guide (MCP auto-discovery and OAuth dynamic registration supported).
> 2. Paste that config into your AI coding assistant (Claude Code, Codex CLI, ChatGPT connectors and others all understand standard `mcpServers` JSON).
> 3. Paste the policy block above into your repository's `AGENTS.md` (or `CLAUDE.md`); a user-level resident instruction variant is available on the /mcp page to cover all your repositories at once. The agent then follows it in every session for that repo.
>
> Tool semantics, guardrails and the full workflow recipe: [docs/coding-agent-mcp.md](docs/coding-agent-mcp.md).
