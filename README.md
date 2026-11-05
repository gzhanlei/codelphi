# Radar

**Radar 是 Chandler 产品家族的内部产品知识与变更中心。** 它从 GitHub 代码和发布记录中生成带证据的产品规格与变化摘要。

- 生产域名（规划）：`https://radar.chandler.work`
- 统一身份：`https://app.chandler.work` / WorkMembership OAuth 2.0
- 数据库：现有腾讯云 MySQL 8 中的独立 `radar` 数据库
- AI：现有 LLMGateway 或其他 OpenAI 兼容的非流式接口
- 首个试点：Radar 分析自己的 GitHub 仓库

## 已实现

- Chandler OAuth 授权码 + PKCE（S256）登录、HttpOnly 会话、个人工作区自动创建；共享工作区按成员与邀请授权。
- GitHub App Manifest 创建与安装、只读 Installation Token、AES-GCM 凭据加密、连接检查与本地断开。
- Integrations 页面与添加产品时的 GitHub App/PAT 凭据选择；无凭据时提供配置引导。
- Gitee、GitLab、Gitea 的工作区级连接配置与服务端验证；目前添加产品和代码分析仍仅支持 GitHub。
- 代码平台 Provider 抽象：注册、分支与变更读取、源码后端及仓库链接统一通过 adapter；当前仅注册 GitHub 分析实现。
- 自有 Git 服务使用 HTTPS 与 `REPOSITORY_HOST_ALLOWLIST` 精确主机/端口白名单；删除令牌连接会清除保存的凭据。
- 两级功能树、功能与场景 CRUD、人工来源保护、软删除 tombstone 和父子层级事务保护。
- 场景分类/全文筛选、列表与表格视图，以及基于场景推导的 SVG 用户流程图。
- GitHub push Webhook HMAC-SHA256 验签及默认分支过滤。
- 手动分析与 push 自动分析；每次分析记录运行状态和错误。
- 当前版本不生成或展示系统架构图，也不外接架构服务；产品卡片只等待 `queued/running` 分析结束。
- 不可变 Spec Version 快照，合并人工功能与场景，并计算确定性的功能/场景行为 Diff。
- 发布页优先展示行为变化及前后差异，Commit 与 AI 摘要仅作为证据和补充。
- LLM 结构化输出校验、代码证据路径校验。
- MySQL 版本化迁移、Radar 自产品注册脚本。
- 自动分析仅更新 generated 内容，不覆盖 manual 功能或场景；生成功能名作为稳定关联键不可直接修改。
- 响应式中文界面。

## 本地启动

### 1. 准备配置

```bash
cp .env.example .env
openssl rand -hex 32  # 填入 SESSION_SECRET
openssl rand -hex 32  # 填入 GITHUB_WEBHOOK_SECRET
```

编辑 `.env`，至少填写：

- `DATABASE_URL`：腾讯云 MySQL 的 `mysql://` URL，数据库名为 `radar`。
- `CHANDLER_CLIENT_ID` / `CHANDLER_CLIENT_SECRET`。
- `AUTH_ALLOWED_EMAILS`（可选）：特殊封闭部署的登录限制，英文逗号分隔；留空允许所有有效 Chandler 用户，不用于工作区成员管理。
- `GITHUB_TOKEN`：对内部仓库具有只读权限的 Token。
- `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`：LLMGateway 配置。

`DATABASE_SSL=true` 为默认值；只有在 VPC 内网且明确不需要 TLS 时才设为 `false`。密码等配置不会写入 Git。

### 2. 创建独立数据库和账号

由 MySQL 管理员在**现有腾讯云实例**中执行（替换密码和网段，不要在聊天中提交真实密码）：

```sql
CREATE DATABASE radar CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'radar'@'%' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES, DROP
ON radar.* TO 'radar'@'%';
FLUSH PRIVILEGES;
```

Radar 不使用 WorkMembership 的业务表。生产环境建议按实际应用网段收紧账号 Host，并定期轮换密码。

### 3. 初始化并启动

```bash
npm install
npm run db:create
npm run db:migrate
npm run db:seed
npm run dev
```

打开 `http://localhost:3000`，点击“使用 Chandler 登录”。

### 添加其他产品

登录后点击产品总览右上角的“添加产品”，填写产品名称、URL Slug、GitHub `owner/repo` 和默认分支。Radar 会先验证仓库读取权限，再写入产品与仓库记录；保持“添加后立即分析”选中即可生成第一版规格。

也可以在本地对已经注册的产品手动执行：

```bash
npm run analyze -- <产品-slug>
```

当前阶段每个产品先接入一个主仓库。GitHub Token 必须对新增仓库具有读取权限。

### 4. 配置 Chandler OAuth

在 `https://app.chandler.work/partner/apps` 创建 Radar 应用，scope 为 `openid profile email`，登记以下回调：

```text
http://localhost:3000/auth/callback
https://radar.chandler.work/auth/callback
```

有效 Chandler 用户默认可登录并自动获得个人工作区。共享工作区通过成员与邀请授权；只有特殊封闭部署才需要配置 `AUTH_ALLOWED_EMAILS`，留空不会拒绝用户。

### 使用 GitHub App（推荐）

打开 `/integrations`，点击“创建 Radar GitHub App”，在 GitHub 官方页面完成创建，然后点击“添加安装”。App 仅申请 `contents:read` 和 `metadata:read`；新 App 的 Manifest 同时声明 App 级 Webhook URL 与 `push` 事件，安装后所选仓库的默认分支更新会自动通知 Radar。已有 App 可点击“设置 Push 通知”跳转 GitHub 设置，一次性补设相同 URL、Webhook Secret 和事件；GitHub 没有更新 App Webhook 的公开 REST API，因此旧 App 需要这一次手工操作。

安装时可选择全部仓库或指定仓库。Radar 将 App 私钥、Client Secret 和 Webhook Secret 使用 AES-256-GCM 加密后存入 MySQL，仅在服务端内存中解密换取 Installation Token 或验证 Webhook。页面支持重新检查连接和本地断开；断开不会卸载 GitHub App，也不会删除已有规格。

添加产品时选择对应的 GitHub App 安装即可；现有 `GITHUB_TOKEN` 仅作为兼容回退。

### 5. 配置 GitHub Webhook

新 GitHub App 会自动配置 App 级 Webhook；已有 App 在 `/integrations` 点击“设置 Push 通知”，在 GitHub App 设置中一次性填写相同 URL、将 Webhook Secret 设为部署环境的 `GITHUB_WEBHOOK_SECRET`，并订阅 `push`。接收端同时接受 App Webhook Secret 与旧的 `GITHUB_WEBHOOK_SECRET`，因此迁移期间已有的逐仓 Webhook 不会中断，缺少已保存 App Secret 的旧 App 也能使用环境变量 Secret 完成验签。

#### 旧 App 迁移（一次性手工操作）

GitHub 没有更新 App Webhook 的公开 REST API，因此在本功能上线前创建的 App 需要在 GitHub 网页补配一次。注意 URL/Secret 和事件订阅是**两个独立的设置区域**，两处都要完成：

1. **Webhook**（App 设置 → Webhook 标签）：
   - 勾选 Active，Payload URL 填 `https://<部署域名>/api/webhooks/github`
   - Webhook secret 填服务器 `.env` 中的 `GITHUB_WEBHOOK_SECRET`（GitHub 不回显已保存的值，核对只能重新粘贴）
2. **事件订阅**（App 设置 → Permissions & events → 底部 **Subscribe to events**）：勾选 **Push**，点击 Save changes。最容易漏的一步——只填 Webhook 表单不会订阅事件，push 不会有任何投递。
3. **验证**：App 设置 → Advanced → Recent Deliveries：
   - 保存 secret 后对 ping 点 Redeliver，应返回 200
   - 推送一个 commit，应出现一条 202 投递，产品页自动开始分析

排错速查：

- **返回 401 invalid_signature**：GitHub 端保存的 Secret 与服务器不一致。在服务器本地用同一 Secret 对测试 payload 计算 HMAC 后 curl 部署地址的 `/api/webhooks/github`，本地 200 而线上 401 即可确认是 Secret 粘贴问题，重新粘贴即可。
- **push 后完全没有投递记录**：事件未订阅，回到第 2 步勾选 Push。
- **修改 Secret 后没有自动 ping**：GitHub 更新 Secret 不重发事件，需在 Advanced → Recent Deliveries 手动 Redeliver。

不使用 App 级通知时，仍可在单个仓库的 Webhook 设置中手工填写：

```text
Payload URL: https://radar.chandler.work/api/webhooks/github
Content type: application/json
Secret: 与 GITHUB_WEBHOOK_SECRET 相同
Events: Push events
```

本地不需要 Webhook 即可验证分析：

```bash
npm run analyze -- radar
```

Webhook 和页面上的“立即分析”都通过 Next.js `after()` 在响应后执行任务，因此生产部署应使用持久运行的 Node.js 服务，而不是请求结束即冻结的 Serverless 平台。

## 数据与安全边界

- Radar 只保存 Chandler `sub`、邮箱、显示名和头像；不保存 Chandler 密码或 OAuth token。
- 每次会话有效期 7 天，过期后重新通过 Chandler 登录。
- AI 只能引用本次读取的代码或 diff 文件，未知证据路径会使分析失败。
- 代码仅发送给配置的 AI 网关；应确保 LLMGateway 及其上游符合内部代码保密要求。
- GitHub 优先使用按仓库授权的 GitHub App Installation Token，服务端共享 PAT 仅作兼容回退。
- 每次 push 当前采用小仓库全量规格重建 + 本次 diff 分析；大仓库的增量索引留待后续版本。

## 常用检查

```bash
npm run typecheck
npm test
npm run build
```

## 部署

生产部署应使用持久运行的 Node.js 服务（例如 systemd 管理的 `next start`，前端经 Nginx 反代），而不是请求结束即冻结的 Serverless 平台——Webhook 和页面上的“立即分析”都依赖 Next.js `after()` 在响应后继续执行任务。

发布流程参考：

```bash
# 本地：验证后推送
npm run typecheck && npm test && npm run build
git push origin main

# 服务器：拉取、构建、重启
git pull --ff-only origin main
npm install   # 依赖变更时
npm run build
systemctl restart radar.service
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3008/login
```

说明：

- 服务器建议通过只读的 GitHub deploy key 拉取代码。
- 数据库迁移未纳入部署流程，schema 变更需在服务器上手动执行 `npm run db:migrate`。
- Explainer 导出需要 Chrome/Chromium，通过环境变量 `ARCHIFY_CHROME` 指定可执行文件路径；常规产品分析不依赖它。

## 后续计划

1. 用 Radar 的真实提交评估分析准确性，完善证据链接与人工修正界面。
2. 增加跨产品问答和每周摘要。
3. 接入 SalesBuddy、Chandler、EasyMakePPT、听风等其他产品。
4. 按实际需要再增加 GitHub App、增量检索、飞书通知和 MCP。
