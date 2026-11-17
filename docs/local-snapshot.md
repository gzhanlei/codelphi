# 本地产品现状快照（单文件 HTML / Skill）

CoDelphi Snapshot 用于**一次性了解一个产品的当前状态**：输入本地 Git 仓库或 GitHub 公开仓库，生成一份包含功能、场景、源码证据和分析边界的单一 HTML。它不是 CoDelphi 服务端的本地副本，不创建持续行为账本。

## 运行要求

- Node.js 22 或更新版本。
- 系统可用的 `git`。
- 以下两种 AI 来源之一：
  - **宿主模式（优先）**：Kimi、ZCode、WorkBuddy、Claude Code、Codex、Cursor 等宿主通过官方能力提供当前模型；用户不重复选择模型或配置同一端点。
  - **standalone 模式**：直接运行 CLI、没有宿主上下文时，使用 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`。

## 仓库内 CLI

```bash
# 中文交互与中文 HTML；使用 standalone AI 配置
npm run snapshot -- /path/to/repo --language zh-CN --output report.html

# 英文交互与英文 HTML；分析公开 GitHub 仓库的指定分支
npm run snapshot -- https://github.com/owner/repo --ref main --language en --output report.html

# 限定 monorepo 的一个或多个源码范围
npm run snapshot -- /path/to/repo --scope apps/web --scope packages/shared --output report.html
```

默认分析 HEAD 的固定 commit。可以显式传入 `--ref <commit|branch|tag>`。只读取 Git 对象，不把未提交或未跟踪文件混入快照；工作区 dirty 时，CLI 和报告都会提示。

standalone 配置来自进程环境，或显式指定文件：

```bash
npm run snapshot -- /path/to/repo \
  --standalone \
  --env-file /secure/config/codelphi-ai.env \
  --output report.html
```

`--env-file` 只读取 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`，不会加载其中的 `DATABASE_URL` 等其他变量，也不会自动读取被分析仓库或当前目录的 `.env`。已有进程环境变量优先于文件值。不要把 AI key 放在命令行参数中。

输出已存在时必须显式 `--force` 才会覆盖。默认输出到当前工作目录的 `codelphi-<repo>-<shortSha>.html`，不写入被分析仓库；写入采用临时文件和原子落盘，失败不会留下标称成功的半成品。

## Skill 构建与使用

```bash
npm run snapshot:skill
# 产物：dist/codelphi-snapshot-skill/
#   SKILL.md
#   scripts/snapshot.cjs
```

`dist/` 不提交到 Git。生成的 bundle 包含 CLI、共享分析核心和宿主 resolver，不需要目标目录存在 CoDelphi 源码、根 `node_modules`、Next.js 或 MySQL。

Skill 的职责只有：识别目标与调用语言、调用 CLI、返回 HTML。不要在 Skill 内复制提取 prompt，也不要让 agent 先读取整仓再自行总结。

### 中英文规则

用户本次调用 Skill 的主要语言同时决定：

1. Skill 的说明、进度、错误与交付消息；
2. 传给 CLI 的 `--language zh-CN` 或 `--language en`；
3. AI 功能/场景文本；
4. HTML 的 `lang`、导航、搜索、筛选、warnings、空态、可信边界和无障碍文案。

不根据仓库 README、宿主地区或模型默认语言改变这个选择。standalone 用户通过 `--language` 直接指定。

## 宿主 AI 接入契约

核心只依赖 `StructuredCompletionClient`，不包含 Kimi、Claude Code、Codex、Cursor 等宿主产品分支。宿主适配层可使用三类官方能力：

### 1. 进程内 client

程序化调用方向 `runSnapshot` 注入 `client` 和 `hostContext.adapters`。适配器返回 `in_process` capability，并在完成后执行 `dispose()`。

### 2. 宿主拥有的本地桥接

宿主注入：

```text
CODELPHI_SKILL_HOST=<宿主身份>
CODELPHI_HOST_AI_BRIDGE_URL=<宿主提供的 completion URL>
CODELPHI_HOST_AI_BRIDGE_TOKEN=<可选的短期授权值>
CODELPHI_HOST_MODEL=<可选、允许披露的模型显示名>
```

CLI 向桥接发送：

```json
{"messages":[{"role":"user","content":"..."}]}
```

请求不携带 `model`，由宿主当前配置决定模型。桥接可返回 `{"content":"..."}` 或 OpenAI 风格的 `choices[0].message.content`。授权值不会写入报告或日志。

### 3. 宿主官方 completion CLI

宿主注入：

```text
CODELPHI_SKILL_HOST=<宿主身份>
CODELPHI_HOST_AI_COMMAND=<官方命令>
CODELPHI_HOST_AI_ARGS_JSON=<JSON 字符串数组>
CODELPHI_HOST_MODEL=<可选显示名>
```

命令通过 stdin 接收 `{"messages":[...]}`，通过 stdout 返回 completion 文本、`{"content":"..."}` 或 OpenAI 风格响应。不得仅凭可执行文件存在就推断授权，也不得扫描其他宿主的私有配置或凭据文件。

### 宿主不可用时

有 `CODELPHI_SKILL_HOST` 上下文但没有可用模型接口时，CLI 返回 `host_ai_unavailable`，即使环境中存在 `AI_*` 也不会静默使用。只有用户明确选择 standalone 后，才添加 `--standalone`（或显式 `--env-file`）使用独立配置。

## 宿主支持矩阵

宿主无关契约和模拟实现已验证；**Claude Code 已通过官方 CLI 适配与真实快照验收，其他具体宿主尚未标为官方支持**：

| 宿主 | 状态 | 说明 |
| --- | --- | --- |
| Kimi | 未验证 | 待核实官方当前模型调用能力与真实验收 |
| ZCode | 未验证 | 待核实官方当前模型调用能力与真实验收 |
| WorkBuddy | 未验证 | 待核实官方当前模型调用能力与真实验收 |
| Claude Code | 已支持（2026-11-17） | 已通过官方 `claude -p` 非交互 CLI 使用当前配置模型，完成真实 `DeanChensj/jiangshan-map` 快照；未另指定模型 |
| Codex | 未验证 | 待核实官方当前模型调用能力与真实验收 |
| Cursor | 未验证 | 待核实官方当前模型调用能力与真实验收 |

每个宿主只有在官方能力明确、adapter contract tests 通过且真实验收完成后，才能改为 `supported`。

## 单一 HTML 内容与边界

HTML 内联 CSS、JavaScript、结构化 JSON 和实际读取的证据代码片段，可单独复制并离线打开。没有 CDN、远程字体、自动网络请求或外部运行依赖。禁用 JavaScript 后仍可阅读全部内容；搜索和分类筛选是渐进增强。

报告按第一次接触项目的阅读顺序组织：

1. 一句话说明产品能做什么；
2. 4–6 个核心能力及用户价值；
3. 典型使用场景，以用户操作和可见结果为主；
4. 完整产品规格，保留功能、情境/操作/结果场景和分类筛选；
5. 默认收起的源码证据，以及覆盖率、重试、清洗和截断边界。

核心能力归组只重新组织已有规格，不新增事实：每个原功能必须恰好出现一次，场景引用必须指向原有功能与场景；无法通过校验时使用确定性回退投影。归组失败不会阻断完整规格和证据输出。

有效源码覆盖率只按文件数计算：有效文件装配数 ÷ 有效文件总数。GeoJSON、数据目录中的结构化数据、CI 和锁文件不进入分母；这些数据文件单独披露。该指标仍不代表正确率或完整理解度。

**功能与简介是未人工核实的 AI 候选。分析成功不等于完整或正确，覆盖装配率不是正确率或测试覆盖率，报告也不表示测试已经执行。**

单份证据片段最多 80 行，内嵌证据源码总预算 2 MB；达到上限会显示 warning，不会静默省略。无有效证据功能、候选全部被清洗或没有支持源码时，不生成成功报告。

## 分析进度与错误诊断

CLI 会输出分析分区总数、每个分区的开始／完成／耗时、模型重试，以及核心能力归组阶段。即使分析不限分区数，也能看到当前正在处理哪一个分区，而不是只在开始和结束时等待。

宿主模型调用超时会显示 `host_cli_timeout`，并提示查看前面的分区进度。可以通过 `CODELPHI_HOST_AI_TIMEOUT_MS` 调整宿主调用超时，当前真实适配示例使用 600000ms；这不会改变分区数量。

## 当前不做什么

- 持续分析、增量状态、历史版本、release、Webhook、轮询、Git hook、PR 评论或 Checks。
- 私有 GitHub 仓库、SSH URL、GitLab/Gitee/Gitea、非 Git 普通目录。
- 未提交工作区的临时内容快照。
- 架构图、完整调用图、运行时行为证明、测试执行或正确性评分。
- 未经核实的全宿主模型兼容承诺。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run snapshot:skill
```

`tests/snapshot-skill.test.ts` 会把 Skill 复制到没有 CoDelphi 源码和根 `node_modules` 的临时目录，使用本地 Git 仓库和模拟宿主/standalone 网关生成真实 HTML，不产生真实 AI 费用，也不连接 MySQL。`tests/snapshot-presentation.test.ts` 另外锁定核心能力归组的完整功能覆盖、合法场景引用、禁止新增事实和确定性回退。

截至 2026-11-17：真实本地 Git、真实公开 GitHub clone/ref/cleanup、离线 HTML 和模拟 AI 已验证；Claude Code 已通过真实模型生成验收，产出内容仍需人工核实，其他具体宿主的官方接口尚未验收。
