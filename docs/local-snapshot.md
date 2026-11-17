# CoDelphi Radar（单文件 HTML / Skill）

CoDelphi Radar 用于**一次性理解一个产品的当前状态**：输入本地 Git 仓库或 GitHub 公开仓库，生成一份包含功能、场景、源码证据和分析边界的单一 HTML。它不是 CoDelphi 服务端的本地副本，不创建持续行为账本。

## 运行要求

- Node.js 22 或更新版本。
- 系统可用的 `git`。
- 以下两种执行方式之一：
  - **宿主原生模式（优先）**：Kimi、Claude Code、Codex、Cursor 等 agent 宿主使用自己的当前模型完成工作单，不需要额外模型接口或凭据。
  - **standalone 模式**：直接运行 CLI、没有宿主上下文时，显式使用 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`。

## 宿主原生：prepare → 工作单 → finalize

```bash
# 中文交互与中文 HTML
node codelphi-radar/scripts/snapshot.cjs prepare /path/to/repo --workdir .radar-work --language zh-CN

# 英文交互与英文 HTML，分析公开 GitHub 仓库的指定分支
node codelphi-radar/scripts/snapshot.cjs prepare https://github.com/owner/repo --ref main --workdir .radar-work --language en

# 可重复 --scope，限定 monorepo 范围
node codelphi-radar/scripts/snapshot.cjs prepare /path/to/repo --scope apps/web --scope packages/shared --workdir .radar-work
```

`prepare` 固定分析 commit，生成：

- `manifest.json`：目标、revision、scope、语言、契约版本和分区清单；
- `work-orders/<partition-id>.json`：消息、源码、变更上下文和证据允许集；
- `results/`：由宿主写入结果。

宿主通过 `show --workdir <目录> --partition <id>` 读取每个工作单；该命令会把已完成结果中的功能名注入后续 prompt，保持跨分区命名连续。宿主执行返回的 system/user messages，把结构化 JSON 写入 `results/<partition-id>.json`，然后执行：

```bash
node codelphi-radar/scripts/snapshot.cjs finalize --workdir .radar-work
```

`finalize` 使用共享 schema、证据校验、清洗、合并和确定性展示生成 `radar.html`。缺失、重复、无效或契约不兼容的结果不会生成成功报告。可以只修正失败分区后重试，已完成结果会在再次 prepare 时保留。

宿主原生模式不需要 `CODELPHI_HOST_AI_COMMAND`、桥接 URL、token、adapter 或 `AI_*` 环境变量。`SKILL.md` 不复制提取 prompt，宿主也不需要直接读取整仓。

## 仓库内一次性 CLI / standalone

```bash
# 中文交互与中文 HTML；使用 standalone AI 配置
npm run snapshot -- /path/to/repo --language zh-CN --output report.html

# 英文交互与英文 HTML；分析公开 GitHub 仓库的指定分支
npm run snapshot -- https://github.com/owner/repo --ref main --language en --output report.html

# 限定 monorepo 的一个或多个源码范围
npm run snapshot -- /path/to/repo --scope apps/web --scope packages/shared --output report.html
```

默认分析 HEAD 的固定 commit。可以显式传入 `--ref <commit|branch|tag>`。只读取 Git 对象，不把未提交或未跟踪文件混入分析；工作区 dirty 时，CLI 和报告都会提示。

standalone 配置来自进程环境，或显式指定文件：

```bash
npm run snapshot -- /path/to/repo \
  --standalone \
  --env-file /secure/config/codelphi-ai.env \
  --output report.html
```

`--env-file` 只读取 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`，不会加载其中的 `DATABASE_URL` 等其他变量，也不会自动读取被分析仓库或当前目录的 `.env`。已有进程环境变量优先于文件值。不要把 AI key 放在命令行参数中。只有用户明确选择 standalone 时才使用独立配置，宿主原生模式不会静默回退。

输出已存在时必须显式 `--force` 才会覆盖。默认输出到当前工作目录的 `codelphi-<repo>-<shortSha>.html`，不写入被分析仓库；写入采用临时文件和原子落盘，失败不会留下标称成功的半成品。

## Skill 构建与安装

```bash
npm run radar:skill
# 产物：dist/codelphi-radar/
#   SKILL.md
#   scripts/snapshot.cjs
```

`dist/` 不提交到 Git。生成的 bundle 包含 CLI、共享分析核心、工作单协议和 standalone 驱动，不需要目标目录存在 CoDelphi 源码、根 `node_modules`、Next.js 或 MySQL。

主产品安装页 `/skills/codelphi-radar` 提供构建与安装说明。运行 `npm run radar:package` 会同时生成 `dist/codelphi-radar/` 和 `dist/codelphi-radar.zip`，不预先假设存在某个 Release 资产。Skill 的职责只有识别目标与语言、准备和完成工作单、返回 HTML，不在 Skill 内复制提取 prompt，也不要求 agent 先读取整仓再自行总结。

### 中英文规则

用户本次调用 Skill 的主要语言同时决定：

1. Skill 的说明、进度、错误与交付消息；
2. 传给 CLI 的 `--language zh-CN` 或 `--language en`；
3. AI 功能/场景文本；
4. HTML 的 `lang`、导航、搜索、筛选、warnings、空态、可信边界和无障碍文案。

不根据仓库 README、宿主地区或模型默认语言改变这个选择。standalone 用户通过 `--language` 直接指定。

## 单一 HTML 内容与边界

HTML 内联 CSS、JavaScript、结构化 JSON 和实际读取的证据代码片段，可单独复制并离线打开。没有 CDN、远程字体、自动网络请求或外部运行依赖。禁用 JavaScript 后仍可阅读全部内容；搜索和分类筛选是渐进增强。

报告按第一次接触项目的阅读顺序组织：

1. 一句话说明产品能做什么；
2. 4–6 个核心能力及用户价值；
3. 典型使用场景，以用户操作和可见结果为主；
4. 完整产品规格，保留功能、情境/操作/结果场景和分类筛选；
5. 默认收起的源码证据，以及覆盖率、重试、清洗和截断边界。

核心能力归组只重新组织已有规格，不新增事实：每个原功能必须恰好出现一次，场景引用必须指向原有功能与场景；无法通过校验时使用确定性回退投影。归组失败不会阻断完整规格和证据输出。宿主原生模式没有额外 completion client 时，直接使用确定性展示回退。

**功能与简介是未人工核实的 AI 候选。分析成功不等于完整或正确，覆盖装配率不是正确率或测试覆盖率，报告也不表示测试已经执行。**

单份证据片段最多 80 行，内嵌证据源码总预算 2 MB；达到上限会显示 warning，不会静默省略。无有效证据功能、候选全部被清洗或没有支持源码时，不生成成功报告。

## 当前不做什么

- 持续分析、增量状态、历史版本、release、Webhook、轮询、Git hook、PR 评论或 Checks。
- 私有 GitHub 仓库、SSH URL、GitLab/Gitee/Gitea、非 Git 普通目录。
- 未提交工作区的临时内容。
- 架构图、完整调用图、运行时行为证明、测试执行或正确性评分。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run radar:skill
```

`tests/snapshot-skill.test.ts` 会把 Skill 复制到没有 CoDelphi 源码和根 `node_modules` 的临时目录，使用本地 Git 仓库和模拟宿主/standalone 网关生成真实 HTML，不产生真实 AI 费用，也不连接 MySQL。`tests/snapshot-workspace.test.ts` 锁定 prepare/finalize、缺失/重复/无效结果、契约版本不兼容和结果恢复。`tests/snapshot-presentation.test.ts` 锁定核心能力归组的完整功能覆盖、合法场景引用、禁止新增事实和确定性回退。
