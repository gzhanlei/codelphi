# Radar

**Radar 是 Chandler 产品家族的内部产品知识与变更中心。** 它从 GitHub 代码和发布记录中生成带证据的产品规格与变化摘要。

- 生产域名（规划）：`https://radar.chandler.work`
- 统一身份：`https://app.chandler.work` / WorkMembership OAuth 2.0
- 数据库：现有腾讯云 MySQL 8 中的独立 `radar` 数据库
- AI：现有 LLMGateway 或其他 OpenAI 兼容的非流式接口
- 首个试点：Radar 分析自己的 GitHub 仓库

## 已实现

- Chandler OAuth 授权码 + PKCE（S256）登录、HttpOnly 会话、生产邮箱白名单。
- 产品总览、功能规格、正常/边界/错误场景、发布与变化列表。
- GitHub push Webhook HMAC-SHA256 验签及默认分支过滤。
- 手动分析与 push 自动分析；每次分析记录运行状态和错误。
- LLM 结构化输出校验、代码证据路径校验。
- MySQL 版本化迁移、Radar 自产品注册脚本。
- 自动分析仅更新 generated 内容，不覆盖 manual 功能或场景。
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
- `AUTH_ALLOWED_EMAILS`：允许登录的 Chandler 邮箱，英文逗号分隔。
- `GITHUB_TOKEN`：对内部仓库具有只读权限的 Token。
- `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`：LLMGateway 配置。

`DATABASE_SSL=true` 为默认值；只有在 VPC 内网且明确不需要 TLS 时才设为 `false`。密码等配置不会写入 Git。

### 2. 创建独立数据库和账号

由 MySQL 管理员在**现有腾讯云实例**中执行（替换密码和网段，不要在聊天中提交真实密码）：

```sql
CREATE DATABASE radar CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'radar'@'%' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT SELECT, INSERT, UPDATE, CREATE, INDEX, ALTER, REFERENCES, DROP
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

### 4. 配置 Chandler OAuth

在 `https://app.chandler.work/partner/apps` 创建 Radar 应用，scope 为 `openid profile email`，登记以下回调：

```text
http://localhost:3000/auth/callback
https://radar.chandler.work/auth/callback
```

生产环境如果 `AUTH_ALLOWED_EMAILS` 为空，Radar 默认拒绝所有登录。

### 5. 配置 GitHub Webhook

在 `gzhanlei/radar` 的 Webhook 设置中填写：

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
- 目前 GitHub 使用服务端共享只读 Token，后续多产品接入可升级为 GitHub App。
- 每次 push 当前采用小仓库全量规格重建 + 本次 diff 分析；大仓库的增量索引留待后续版本。

## 常用检查

```bash
npm run typecheck
npm test
npm run build
```

## 后续计划

1. 用 Radar 的真实提交评估分析准确性，完善证据链接与人工修正界面。
2. 增加跨产品问答和每周摘要。
3. 接入 SalesBuddy、Chandler、EasyMakePPT、听风等其他产品。
4. 按实际需要再增加 GitHub App、增量检索、飞书通知和 MCP。
