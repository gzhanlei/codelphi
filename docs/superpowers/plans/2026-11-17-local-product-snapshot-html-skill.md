# 本地产品现状快照与单文件 HTML Skill 开发计划

> **目标：** 输入一个本地 Git 仓库或 GitHub 公开仓库 URL，一次性生成可离线打开、可独立分享的产品现状 HTML 报告。Skill 只负责识别意图、调用 CLI 和交付报告，不承载分析算法。
>
> **定位：** 本地工具是“一次性产品理解报告生成器”，不是 CoDelphi 服务端的本地副本，不做持续行为账本。

**Architecture:** 复用现有源码索引、切片规划、AI 提取、证据清洗、确定性合并和覆盖率计算。新增本地 Git backend 与无数据库的 snapshot orchestration；服务端继续走 MySQL 版本链，本地工具直接生成 `SnapshotReportData` 并渲染单文件 HTML。公开 GitHub 仓库克隆到临时目录后与本地仓库共用同一 Git backend。

**Tech Stack:** TypeScript、Node.js 22、系统 Git、宿主已配置的模型调用能力（优先）与现有 OpenAI 兼容 LLM 网关（standalone 兜底）、Zod、Vitest；HTML 使用内联 CSS 与少量无框架 JavaScript；Skill 分发包通过 esbuild 生成，不要求目标机器安装 CoDelphi 的 Next.js/MySQL 运行环境。

## 实施状态（2026-11-17）

- Tasks 1–6 已实现：共享 client/提取层、本地 Git backend、无数据库快照分析、中英文单文件 HTML、local/GitHub CLI、三类宿主 AI 契约与独立 Skill bundle。
- M1/M2 工程能力已完成；`dist/codelphi-snapshot-skill/` 已生成并验证可脱离仓库运行。Claude Code 官方 CLI 适配已完成一次真实公开仓库分析。
- 全量 259 个测试文件通过、typecheck 通过、Next.js 构建成功、Skill 独立分发测试通过；真实公开 GitHub clone/ref/cleanup 与 HTML 桌面/窄屏交互已验证。
- Task 7 文档已完成。Claude Code 已通过真实生成验收，AI 结论仍需人工核实；其他产品宿主的官方接口和真实宿主验收仍为未验证事项，未执行生产部署。
- 页面信息架构已按首次理解项目重排：一句话简介 → 核心能力 → 典型使用场景 → 完整产品规格 → 默认收起的源码证据与分析边界。核心能力只归组既有规格并校验完整覆盖，不新增产品事实。
- 覆盖口径已改为有效文件覆盖率：只按文件数计算，GeoJSON 等结构化数据、CI 和锁文件不进入分母；不再使用字节覆盖率。CLI 已补充分区开始／完成／耗时、模型重试与核心能力归组进度。

**现状依据：**

- `lib/remote-source-index/types.ts` 的 `RemoteSourceBackend` 已抽象 revision、tree 和 blob 读取，`createRemoteSourceIndex` 支持注入 backend。
- `lib/remote-analysis.ts` 的分区装配不依赖 GitHub 所有权；`lib/analysis-coverage.ts` 可复用覆盖率口径。
- `scripts/measure-first-analysis.ts` 已提供“不建产品、不写库、不落计费”的一次性多分区提取参考链路。
- `lib/analysis.ts` 的完整 `runAnalysis` 同时处理发布、增量、通知、计费和 MySQL，不作为本地 CLI 的入口。
- `docs/analysis-pipeline.md` 明确 full 也是受预算约束的源码窗口分析，不能宣称读取并理解了整个仓库。
- 2026-11-17 当前会话未连接 `codelphi` MCP，`lookup_by_files` 不可用。本计划已按源码核对影响面；实施时若 MCP 恢复，应先反查每个 Modify 文件对应的功能/场景。若仍不可用，须明确“账本影响面未知”，不得声称完成 MCP 对账。

## 交付结果

用户可以得到：

```bash
# 仓库内开发/验证入口
npm run snapshot -- /path/to/repo --output report.html
npm run snapshot -- https://github.com/owner/repo --ref main --output report.html

# 可分发 Skill 包构建入口
npm run snapshot:skill
# 产物：dist/codelphi-snapshot-skill/
```

最终 HTML 包含：

1. 产品概况：产品是什么、面向谁、主要能力是什么；没有有效证据时明确显示未知。
2. 功能地图与场景：功能摘要、情境/操作/结果、happy/edge/error 分类。
3. 源码证据：路径、行号和实际读取的代码片段，可从功能/场景跳转。
4. 快照身份：输入来源、仓库名、分支（可得时）、完整 commit SHA、提交时间、报告生成时间。
5. 分析边界：实现面装配数量与字节覆盖率、分区数、触顶、证据清洗、重试和其他截断。
6. 可信边界：规格与简介是未人工核实的 AI 候选；分析成功不等于完整或正确；未覆盖不等于产品不支持；报告不代表测试已经执行。
7. 内嵌结构化 JSON：供后续程序读取，不要求用户管理额外的 `spec.json` 文件。
8. 中英文交互与报告：中文调用 Skill 得到中文交互和中文 HTML，英文调用得到英文交互和英文 HTML；静态界面文案与 AI 内容使用同一语言。

## AI 接入原则：宿主优先，standalone 兜底

- **在宿主 Agent／编程工具中使用 Skill 时，默认使用用户已经在该宿主中配置并授权的当前模型。** Kimi、ZCode、WorkBuddy、Claude Code、Codex、Cursor 等都只是宿主实例；不再要求用户为 CoDelphi 单独选择模型、填写模型名或重复配置同一套 AI 端点。
- 分析核心只依赖注入的 `StructuredCompletionClient`，不直接决定宿主、模型或凭据来源。`HostAiAdapter` 负责能力发现和把宿主当前模型调用转成 client；核心不 import 任何宿主专用 SDK。
- 宿主可以通过进程内 client、宿主官方 CLI 或宿主提供的安全调用桥接接入。具体方式以该宿主公开能力为准，不能把一种宿主的协议硬编码成通用协议。
- 模型身份只记录宿主允许披露的显示名，无法取得时显示“宿主当前模型”，不得编造。桥接认证由适配器处理，不把宿主凭据复制进报告、命令行参数、日志或新的长期配置文件。
- **不假设任何宿主一定开放该能力，也不私自读取其他宿主的配置或凭据文件。** 每个适配器必须先确认官方/宿主授权接口。若未开放，应返回明确的 `host_ai_unavailable`，说明需要的宿主能力；只有用户明确选择 standalone 模式后，才使用独立网关配置，不能静默切换。
- 直接运行 CLI、没有宿主模型上下文时，才使用 `AI_BASE_URL`／`AI_API_KEY`／`AI_MODEL` 或显式 `--env-file` 作为 standalone 兜底。该配置不是宿主 Skill 的前置条件。

### 宿主接入契约

`HostAiAdapter` 统一提供：

- `discover()`：识别宿主明确提供的调用能力，返回 `in_process`、`host_cli`、`local_bridge` 或 `unavailable`；不能仅凭可执行文件存在就推断已授权。
- `createClient()`：基于已发现能力构造 `StructuredCompletionClient`，模型由宿主当前配置决定。
- `dispose()`：关闭临时桥接、子进程和其他资源，不留下常驻服务。

各宿主共用同一套 adapter contract tests，但支持状态必须独立核实：

| 宿主 | 当前模型调用能力 | 适配状态 | 真实验收 |
| --- | --- | --- | --- |
| Kimi | 待核实 | 未承诺 | 待执行 |
| ZCode | 待核实 | 未承诺 | 待执行 |
| WorkBuddy | 待核实 | 未承诺 | 待执行 |
| Claude Code | 已核实（官方 `claude -p`） | 已支持（2026-11-17） | 真实 `DeanChensj/jiangshan-map` 快照已生成 |
| Codex | 待核实 | 未承诺 | 待执行 |
| Cursor | 待核实 | 未承诺 | 待执行 |

只有官方能力明确、adapter contract tests 通过且真实验收完成，才能把某一宿主标为 `supported`。首轮至少完成一个真实宿主适配；其余宿主可保持 `unverified`／`unavailable`，不得写成全宿主兼容。

## Global Constraints

- **一次分析、一个 HTML。** 默认不创建 `.codelphi/` 状态目录，不生成独立 JSON/CSS/JS/图片文件，不写回被分析仓库。
- **不做持续分析。** 本轮不实现 Webhook、轮询、Git hook、文件监听、PR 评论、Checks、发布链、历史版本或本地增量分析。
- **不依赖 CoDelphi 服务。** 本地运行不需要 Chandler 登录、MySQL、组织、计费、通知或 Next.js 服务；AI 调用优先复用宿主已配置模型，standalone CLI 才需要独立 AI 网关配置。
- **共享算法，不复制算法。** Skill 和 CLI 不另写一套切片、prompt、证据校验或合并逻辑；服务端已有行为不得因抽取共用函数而改变。
- **语言由调用语言决定。** Skill 以用户本次调用的主要语言选择 `zh-CN` 或 `en`，并同时用于 Skill 的说明、进度、错误和交付消息以及 HTML；不根据仓库文本、宿主地区或模型默认语言猜测，也不要求用户另行选择。standalone `--language` 仅用于显式运行和接收 Skill 已确定的语言。
- **固定 revision。** 只读取 Git 对象，不隐式分析未提交修改。默认读取 HEAD；工作区 dirty 时在 CLI 和报告中显著提示“未提交/未跟踪内容不在本次快照中”。
- **证据必须来自实际读取窗口。** 本地工具复用逐场景证据清洗，不因为不是服务端产品就放宽路径校验。模型提供的 URL 不作为事实来源，源码链接只由工具根据已解析仓库身份和 SHA 构造。
- **覆盖不足必须可见。** 不把 `full` 展示为“全仓完整理解”；分区触顶、证据片段截断、空趟和候选全被清洗均须进入 warnings。
- **无有效规格不伪装成功。** 没有支持的源码、所有 AI 候选都被清洗、或最终没有任何带证据功能时，命令失败且不生成标称成功的报告。
- **HTML 默认安全。** 所有仓库内容、路径和 AI 文本都按不可信输入转义；无 CDN、远程字体、远程脚本、自动网络请求或 `eval`；内嵌 JSON 必须防止 `</script>` 逃逸。
- **凭据不重复收集、不进入产物。** 宿主模式不提示用户另选模型或重填同一端点；standalone 不支持在命令行传 AI key，可提供 `--env-file <path>` 显式加载配置，但不得自动读取被分析仓库或任意 cwd 的 `.env`。不打印密钥、完整网关响应或源码内容日志；Git 操作禁用交互式凭据提示。
- **服务红线保持不变。** 自动分析不得覆盖 `source='manual'`；现有重试一次、证据清洗粒度、合并、覆盖率和计费语义不变。
- 每批代码提交前运行相关测试；最终运行 `npm run typecheck`、`npm test`、`npm run build`。不执行生产部署、DNS、Webhook 或 Docker 操作。

## Review Focus

- 本地 Git backend 必须继续经过 `RemoteSourceIndex` 的 blob SHA、scope、预算和 prune 校验，不能绕过索引直接任意读文件。
- 未提交工作区、非 Git 目录、空仓库、私有/不存在公开仓库和无效 `--ref` 必须给出真实错误，不能生成身份不明的快照。
- 一次性链路不得意外创建 analysis run、LLM billing receipt、release、notification 或数据库连接。
- 多分区结果仍使用既有确定性合并；证据清洗失败不能被报告包装成“无此功能”。
- HTML 是主要交付物：离线、窄屏、无 JavaScript 可读性、XSS、证据完整性和文件体积都需要验收。
- Skill 是薄入口：不得要求 agent 先读取整仓再自行总结，也不得在 Skill 内复制提取 prompt。
- 宿主模型接入不得退化为隐藏的第二套配置：宿主可用时必须走宿主当前模型；不可用时要明确报错，未经用户选择不得静默使用 standalone AI 配置。

---

### Task 1: 抽象模型调用并抽取平台无关的单趟提取

**Files:**

- Create: `lib/llm-client.ts`
- Create: `lib/extraction-pass.ts`
- Modify: `lib/ai.ts`
- Modify: `lib/analysis.ts`
- Modify: `tests/analysis-evidence.test.ts`
- Modify: `tests/ai.test.ts`
- Create: `tests/extraction-pass.test.ts`

**Interfaces:**

- Create: `StructuredCompletionClient`，接收结构化消息并返回内容，不规定宿主、模型名或凭据来源。
- `analyzeWithAI` 接收可选的注入 client；缺省仍走现有 `requestStructuredCompletion` 与 billing，服务端行为不变。
- Move/keep compatible: `sanitizeEvidence(result, sources, label): EvidenceSanitizeSummary`。
- Move: `evidenceAllowSet(partition, change)`。
- Move: `extractPassWithRetry(options)`，继续调用既有 `analyzeWithAI`，单趟硬失败只重试一次；允许测试注入提取函数，生产默认实现不变。
- `lib/analysis.ts` 使用新模块；对现有 `sanitizeEvidence` 导出保持兼容，或一次性更新全部引用并确认无外部调用。

- [ ] **Step 1: 写失败测试**

覆盖：路径外产品简介/场景/变化分别清洗；同功能有证据场景保留；候选全被清洗返回 `allCandidatesRejected`；第一次网关失败第二次成功；两次失败才抛出；重试不会额外添加 billing 上下文。另验证注入 client 时不需要 `AI_MODEL` 等 standalone 环境变量、调用的是注入 client，而未注入时现有网关与 receipt 调用保持不变。

- [ ] **Step 2: 确认测试失败**

Run: `npx vitest run tests/extraction-pass.test.ts tests/analysis-evidence.test.ts`

Expected: FAIL，新模块尚不存在。

- [ ] **Step 3: 无损移动实现并接回服务端**

移动提取函数及其直接依赖，并为 `analyzeWithAI` 增加可选 client 注入；缺省路径仍调用原网关。不改 schema、prompt、清洗粒度、日志级别或重试次数。`analysis.ts` 的发布、增量、carry-forward、manual 保护和结算路径保持不变。

- [ ] **Step 4: 验证服务端回归**

Run: `npx vitest run tests/extraction-pass.test.ts tests/analysis-evidence.test.ts tests/analysis-run.test.ts tests/analysis-persistence.test.ts tests/ai.test.ts tests/ai-gateway.test.ts`

Expected: PASS；既有 mock 的调用次数和 billing receipt 语义不变。

- [ ] **Step 5: Commit**

```bash
git add lib/llm-client.ts lib/extraction-pass.ts lib/ai.ts lib/analysis.ts tests/analysis-evidence.test.ts tests/ai.test.ts tests/extraction-pass.test.ts
git commit -m "refactor: share evidence-safe extraction passes"
```

### Task 2: 实现固定 revision 的本地 Git 源码后端

**Files:**

- Create: `lib/snapshot/git.ts`
- Create: `lib/snapshot/git-backend.ts`
- Modify: `lib/remote-source-index/types.ts`
- Create: `tests/snapshot-git-backend.test.ts`
- Modify: `tests/remote-source-index.test.ts`

**Interfaces:**

- `resolveGitSnapshot(repoRoot, revision?): Promise<GitSnapshot>`，返回仓库根、完整 commit/tree SHA、分支、提交信息、提交时间和 dirty 状态。
- `createLocalGitBackend(snapshot): RemoteSourceBackend`。
- `SourceBackendKind` 增加 `"local_git"`；远程克隆的读取身份仍由 snapshot source 单独记录，不与 GitHub API backend 混淆。
- Git 子进程统一使用 `execFile` 参数数组，不经过 shell；实现 `resolveRevision`、`listTree`、`listWholeTree`、`fetchBlob`。

- [ ] **Step 1: 用真实临时 Git 仓库写失败测试**

测试动态创建仓库，覆盖：

- HEAD 和显式 commit/ref 解析；空仓库、非法 ref、非 Git 目录报错。
- 嵌套目录、空格/中文路径、空文件、UTF-8 源码；使用 `git ls-tree -z` 等 NUL 分隔输出，不能按换行拆路径。
- `listWholeTree` 返回真实 blob SHA 和大小；`fetchBlob` 返回原始 bytes。
- `RemoteSourceIndex.readLines` 能读取本地 blob，篡改 backend SHA 时仍触发 `blob_sha_mismatch`。
- scope 外路径、prune 文件、过大 blob 和内容预算仍由原索引拒绝。
- 修改工作区但不提交时，读取结果仍是 HEAD；返回 `workingTreeDirty=true`。
- 子进程失败不包含环境变量或密钥；`GIT_TERMINAL_PROMPT=0`。

- [ ] **Step 2: 确认测试失败**

Run: `npx vitest run tests/snapshot-git-backend.test.ts`

Expected: FAIL，本地 backend 不存在。

- [ ] **Step 3: 实现 Git 命令层与 backend**

使用 `rev-parse`、`ls-tree`、`cat-file`、`show`、`status` 等只读命令。blob 按 SHA 读取，不把用户输入拼进 shell。进程 stdout 设置明确上限，超限失败而不是把截断内容标记为完整 tree/blob。

- [ ] **Step 4: 验证 backend 与原索引回归**

Run: `npx vitest run tests/snapshot-git-backend.test.ts tests/remote-source-index.test.ts tests/remote-source-mutation-boundaries.test.ts tests/remote-analysis.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot/git.ts lib/snapshot/git-backend.ts lib/remote-source-index/types.ts tests/snapshot-git-backend.test.ts tests/remote-source-index.test.ts
git commit -m "feat: read snapshot sources from local git objects"
```

### Task 3: 建立无数据库的产品快照分析与报告数据模型

**Files:**

- Create: `lib/snapshot/types.ts`
- Create: `lib/snapshot/analyze.ts`
- Create: `lib/snapshot/report-data.ts`
- Create: `tests/snapshot-analyze.test.ts`
- Create: `tests/snapshot-report-data.test.ts`

**Interfaces:**

- `analyzeProductSnapshot(options): Promise<SnapshotAnalysis>`。
- 输入包含 `RemoteSourceBackend`、仓库快照身份、产品显示名、scope roots、输出语言、`StructuredCompletionClient` 和可注入的提取函数；不接收 repository/product 数据库 ID，也不传 billing。分析核心不得自行读取 `AI_MODEL` 或选择宿主。
- `SnapshotReportData` 至少包含 `schemaVersion`、`language`、`snapshot`、`product`、`features`、`evidenceSnippets`、`coverage`、`warnings`、`analysis`。warnings 使用稳定 code 与结构化参数，由 HTML/CLI 按语言本地化，不在核心层固化中文文案。
- `buildSnapshotReportData(analysis): SnapshotReportData` 为纯投影；不生成 release、spec_changes 或回归任务。

**分析契约：**

- 使用 `getPartitionedAnalysisSources`、Task 1 的 `extractPassWithRetry`、`mergeChunkResults`、`enumerateImplementationSurface` 和 `computeCoverageReceipt`。
- `ChangeContext.files=[]`，commit 信息来自真实 Git snapshot；不运行行为 diff 枚举、历史措辞锚定、增量影响分析或影子对比。
- 各分区沿用已知功能名连续性；每趟允许集只含该分区实际装配文件。
- AI 调用通过调用方注入的 client，不传 CoDelphi billing，因此不写 `llm_call_receipts`；不在 snapshot 模块导入 `db`、billing、notification、release-notes 或 Next.js 模块。
- 证据片段从实际装配 sources/index 中提取，按 `path + startLine + endLine` 去重；无行号、越界行号和截断都如实标记，不伪造代码。
- 证据收集单片段最多 80 行、全部内嵌证据源码最多 2 MB；达到预算时保留已验证片段并增加可见 warning，不能静默省略。

- [ ] **Step 1: 写失败测试**

使用内存 backend 和 stub 提取函数，覆盖：

- 单分区与多分区；第二分区收到第一分区已知功能名。
- 每趟证据允许集独立，跨分区引用被清洗；合并仍调用既有 `mergeChunkResults`。
- 不调用 diff 枚举、不读取上一版规格、不传 billing、不触碰数据库；所有模型请求都经过注入 client，分析核心不读取 standalone AI 环境变量。
- 分区触顶、重试、空趟、证据丢弃、场景去重进入结构化 warnings；不使用单一“健康分”。
- 全部候选被清洗或最终零有效功能时抛 `no_valid_spec`。
- 产品简介证据全部被清洗时显示未知，而不是保留无证据简介。
- 证据片段只包含真实行；重复引用去重，超长片段有明确 truncated 标记。

- [ ] **Step 2: 确认测试失败**

Run: `npx vitest run tests/snapshot-analyze.test.ts tests/snapshot-report-data.test.ts`

Expected: FAIL，snapshot orchestration 不存在。

- [ ] **Step 3: 实现一次性分析和报告数据投影**

参考 `scripts/measure-first-analysis.ts` 的多分区循环，但不复制其中的研究指标和 usage 全局拦截。保留该测量脚本原有口径，不要求它改用 snapshot 报告模型。

- [ ] **Step 4: 验证共享分析回归**

Run: `npx vitest run tests/snapshot-analyze.test.ts tests/snapshot-report-data.test.ts tests/extraction-merge.test.ts tests/analysis-coverage.test.ts tests/analysis-run.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot/types.ts lib/snapshot/analyze.ts lib/snapshot/report-data.ts tests/snapshot-analyze.test.ts tests/snapshot-report-data.test.ts
git commit -m "feat: analyze one-off product snapshots without persistence"
```

### Task 4: 渲染安全、离线、可检索的单文件 HTML

**Files:**

- Create: `lib/snapshot/report-html.ts`
- Create: `lib/snapshot/report-assets.ts`
- Create: `tests/snapshot-report-html.test.ts`
- Create: `tests/fixtures/snapshot-report.json`

**Interfaces:**

- `renderSnapshotHtml(report: SnapshotReportData): string`。
- `report-assets.ts` 只维护 CSS、`zh-CN`/`en` 双语文案和渐进增强 JavaScript 字符串；不依赖 React、Next.js、Archify 或浏览器构建步骤。

**HTML 契约：**

- 完整内容先以静态 HTML 输出；禁用 JavaScript 后仍可阅读功能、场景、证据和覆盖说明。
- `SnapshotReportData.language` 同时决定 AI 输出语言、HTML `lang`、标题、导航、搜索占位、分类筛选、证据控件、warnings、空态、可信边界和无障碍文案；源码、路径、SHA 与技术标识保持原文。
- JavaScript 只增强功能/场景搜索、分类筛选、证据展开和回到顶部；不得通过网络补数据。
- 证据片段嵌入报告，不为本地文件使用不可靠的 `file://` 链接。GitHub 来源可生成固定 SHA permalink，但离线时内容仍完整。
- 每条证据可回到引用它的功能/场景；长路径和长文本可换行，320px 宽度无页面级横向溢出。
- CSS/JS/JSON 全部内联；默认 CSP 禁止网络连接、表单和 base 注入。外部源码链接仅使用工具生成的 HTTPS URL，并带 `rel="noopener noreferrer"`。
- Renderer 只渲染 Task 3 已去重、受预算控制的证据片段，不自行补读源码或静默二次截断；预算 warning 必须可见。
- 内嵌 JSON 放在 `script[type="application/json"]`，对 `<`、`>`、`&`、U+2028/U+2029 做安全序列化。

- [ ] **Step 1: 写失败测试**

覆盖：

- 产品、功能、场景、SHA、覆盖率和 warnings 全部出现；没有 release/push/PR 持续分析入口。
- 中文报告具有 `lang="zh-CN"` 和完整中文界面；英文报告具有 `lang="en"` 和完整英文界面，包括搜索、warnings、空态与 aria-label，不出现只翻译 AI 正文而界面仍混用另一语言的情况。
- 无外部 `src`、远程样式、字体或自动 fetch；断网语义由静态资源检查保证。
- 恶意功能名、路径、场景和代码 `</script><script>...` 不会形成可执行节点；模型提供的钓鱼 URL 不进入链接。
- 内嵌 JSON 可还原报告数据且不闭合宿主 script；页面脚本不使用 `innerHTML`/`eval` 注入模型内容。
- 证据去重、80 行/2 MB 上限及截断 warning；无行号证据不伪造行号。
- 无 JavaScript 时主体内容仍存在；语义标题、label、键盘焦点和 320px 样式规则存在。

- [ ] **Step 2: 确认测试失败**

Run: `npx vitest run tests/snapshot-report-html.test.ts`

Expected: FAIL，renderer 不存在。

- [ ] **Step 3: 实现报告模板与渐进增强交互**

不引入前端框架和第三方 CDN。所有动态文本在静态生成阶段转义，增强脚本只切换已有节点的 hidden/class，不拼接不可信 HTML。

- [ ] **Step 4: 验证渲染与安全测试**

Run: `npx vitest run tests/snapshot-report-html.test.ts tests/snapshot-report-data.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot/report-html.ts lib/snapshot/report-assets.ts tests/snapshot-report-html.test.ts tests/fixtures/snapshot-report.json
git commit -m "feat: render portable product snapshot reports"
```

### Task 5: 提供本地路径与 GitHub 公开仓库 CLI

**Files:**

- Create: `lib/snapshot/target.ts`
- Create: `lib/snapshot/run.ts`
- Create: `scripts/snapshot.ts`
- Modify: `package.json`
- Create: `tests/snapshot-target.test.ts`
- Create: `tests/snapshot-cli.test.ts`

**Interfaces:**

- CLI：`npm run snapshot -- <target> [--ref <revision>] [--scope <path> ...] [--language zh-CN|en] [--env-file <path>] [--standalone] [--output <file>] [--force]`。
- 程序化入口 `runSnapshot(options)` 接受调用方注入的 `StructuredCompletionClient`；CLI 子进程由宿主适配器通过安全桥接提供 client，standalone 才构造 OpenAI 兼容 client。
- `resolveSnapshotTarget(target, options)` 区分本地路径和 `https://github.com/owner/repo[.git]`；返回统一 snapshot、backend、source metadata 和 `cleanup()`。
- 默认输出为当前工作目录的 `codelphi-<repo>-<shortSha>.html`，不写入被分析仓库；已有文件只有显式 `--force` 才覆盖。

- [ ] **Step 1: 写失败测试**

覆盖：

- 本地相对/绝对路径、空格路径、默认 HEAD、显式 ref、重复 scope、`zh-CN`/`en` 语言参数和默认输出文件名；语言同时传给 AI、CLI 消息和 HTML，非法语言退出 2。
- 非 Git 目录、无 commit、非法 URL、非 GitHub host、URL userinfo/query/fragment、私有或不存在仓库均失败。
- GitHub URL 在临时目录执行 blobless/no-checkout clone；成功、失败和 AI 异常都执行 cleanup。
- clone/fetch 设置非交互凭据环境与超时；不把 URL 凭据或环境变量写入日志。
- dirty 工作区仍分析固定 HEAD，但报告包含显著 warning。
- standalone 缺少 AI 配置时给出变量名而不打印值；只从进程环境或显式 `--env-file` 加载，目标仓库和任意 cwd 的 `.env` 不被自动读取；宿主 client 已注入时不校验这些变量，也不要求模型名。直接 CLI 无宿主上下文时 standalone 为默认模式；Skill 有宿主上下文但调用不可用时，必须显式 `--standalone` 才允许 fallback。用法错误退出 2，分析失败退出 1，成功退出 0。
- 输出已存在且无 `--force` 时不覆盖；HTML 写入使用临时文件后原子 rename，失败不留下“成功”半成品。
- stdout 只输出最终报告路径和简短摘要，进度写 stderr；不打印完整源码或 AI 响应。

- [ ] **Step 2: 确认测试失败**

Run: `npx vitest run tests/snapshot-target.test.ts tests/snapshot-cli.test.ts`

Expected: FAIL，target resolver/CLI 不存在。

- [ ] **Step 3: 实现 target 生命周期与薄 CLI**

公开仓库只支持 HTTPS GitHub 地址，本轮不支持 SSH、私有仓库和其他 host。远程克隆与本地路径最终都进入 Task 2 backend。CLI 在开始时显示快照范围和实际 AI 来源（宿主当前模型或 standalone 网关 host），说明源码的数据去向；不显示密钥。脚本不得通过顶层 `dotenv/config` 隐式加载配置。

- [ ] **Step 4: 增加 npm 入口并验证**

`package.json` 增加 `"snapshot": "tsx scripts/snapshot.ts"`。运行：

Run: `npx vitest run tests/snapshot-target.test.ts tests/snapshot-cli.test.ts tests/snapshot-git-backend.test.ts tests/snapshot-analyze.test.ts tests/snapshot-report-html.test.ts && npm run typecheck`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/snapshot/target.ts scripts/snapshot.ts package.json tests/snapshot-target.test.ts tests/snapshot-cli.test.ts
git commit -m "feat: generate product snapshot html from git repositories"
```

### Task 6: 构建独立 Skill 包，保持 Skill 为轻量入口

**Files:**

- Create: `skills/codelphi-snapshot/SKILL.md`
- Create: `lib/snapshot/host-ai.ts`（宿主无关能力发现、client 构造与生命周期）
- Create: `skills/codelphi-snapshot/host-ai.ts`（Skill 侧契约导出）
- Create: `skills/codelphi-snapshot/adapters/`（每个已实现宿主一个独立 adapter；只使用真实开放协议）
- Create: `scripts/build-snapshot-skill.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/snapshot-skill.test.ts`

**Interfaces:**

- `npm run snapshot:skill` 生成 `dist/codelphi-snapshot-skill/SKILL.md` 和 `dist/codelphi-snapshot-skill/scripts/snapshot.cjs`；宿主无关 resolver 与已验证 adapters 一并打包进 CLI，不额外要求宿主安装 SDK。
- 使用直接声明的 esbuild devDependency 将 CLI 及共享核心打包为 Node.js 可执行文件；`dist/` 沿用现有 gitignore，不提交生成 bundle。
- Skill 内的唯一分析执行入口：`node <skill-dir>/scripts/snapshot.cjs <target> ...`；宿主 AI 桥接由适配器建立并注入，standalone 环境变量只在没有宿主上下文时使用。

**Skill 指令边界：**

1. 判断用户给出的目标是本地目录还是 GitHub 公开仓库；收集可选 ref、scope 和输出位置。以本次用户调用的主要语言确定 `zh-CN` 或 `en`，不再询问语言；Skill 的说明、进度、错误与交付消息也使用该语言，并把同一语言传给 CLI/HTML。
2. 通过 `HostAiAdapter` 发现并使用宿主已经授权的当前模型，不判断特定产品名称，不要求用户填写 `AI_MODEL` 或重复配置同一端点。说明源码的数据去向，但不读取或复述宿主凭据。
3. 宿主没有可编程模型调用能力时返回 `host_ai_unavailable`；只有用户明确选择 standalone 后才走独立配置，不能静默回退。
4. 调用 bundled CLI，不让 agent 先遍历仓库、自行重写摘要或复制分析 prompt。
5. 成功后返回宿主可点击的 HTML 路径/链接；宿主支持时才打开，未打开不得声称已打开。
6. 失败时原样保留可操作的错误类别（Git、宿主 AI 不可用、standalone 配置、网关、无有效规格、输出冲突），不伪造 HTML。

- [ ] **Step 1: 写失败测试**

- `SKILL.md` 只包含目标解析、调用语言识别、调用和交付说明，没有第二套提取规则、持续分析或数据库步骤。
- 中文调用得到中文 Skill 消息、`--language zh-CN` 和中文 HTML；英文调用得到英文 Skill 消息、`--language en` 和英文 HTML；不得根据仓库 README 或宿主 locale 改写该选择。
- 构建产物包含 Skill 与 bundled CLI（内含宿主 resolver/已验证 adapters），不包含 `.env`、测试、文档秘密或真实报告；CLI 不自动加载目标目录或当前目录的 `.env`。
- 将产物复制到没有 CoDelphi 源码和根 `node_modules` 的临时目录，在 `DATABASE_URL` 等 CoDelphi 服务变量全部缺省时执行 `--help` 成功。
- 使用模拟宿主当前模型的 client/桥接，在所有 `AI_*` 变量缺省时完成分析；断言没有要求模型名、没有读取 standalone 配置，报告只记录宿主允许披露的身份。
- 用同一组 contract tests 覆盖 `in_process`、`host_cli`、`local_bridge` 三类 adapter：当前模型由宿主决定、资源被清理、错误可识别，核心没有宿主产品分支。
- 模拟任一宿主无模型调用接口时返回 `host_ai_unavailable`，不得静默使用已存在的 `AI_*`；只有显式 standalone 参数才允许 fallback。
- 适配器不得扫描或读取其他宿主的私有配置/凭据文件；没有官方授权接口时保持 `unverified`／`unavailable`。
- 使用本地临时 Git 仓库和本地假 OpenAI 网关验证 standalone 兜底，通过显式 `--env-file` 注入测试配置并生成单一 HTML；假网关只返回带有效证据的小规格，不产生真实 AI 费用。
- 验证运行期间没有 MySQL 连接、analysis run、release 或额外 `spec.json`/CSS/JS 产物。
- 检查 bundled CLI 的帮助与源码 CLI 参数一致，避免分发入口漂移。

- [ ] **Step 2: 确认测试失败**

Run: `npx vitest run tests/snapshot-skill.test.ts`

Expected: FAIL，Skill 与构建入口不存在。

- [ ] **Step 3: 实现构建与 Skill 指令**

esbuild 目标是 Node.js 22，Node built-ins 保持 external。若服务端账务/DB 模块因静态 import 被带入 bundle，优先通过依赖边界消除，而不是增加运行时数据库要求；最终由脱离仓库的 smoke test 证明不需要 MySQL。

- [ ] **Step 4: 构建并验证独立运行**

Run: `npm run snapshot:skill && npx vitest run tests/snapshot-skill.test.ts`

Expected: 构建成功，临时目录中的 bundled CLI 测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add skills/codelphi-snapshot/SKILL.md skills/codelphi-snapshot/host-ai.ts skills/codelphi-snapshot/adapters scripts/build-snapshot-skill.ts package.json package-lock.json tests/snapshot-skill.test.ts
git commit -m "feat: package lightweight product snapshot skill"
```

### Task 7: 真实验收、服务端回归与使用文档

**Files:**

- Create: `docs/local-snapshot.md`
- Modify: `README.md`
- Modify only issues found by verification; no additional feature scope.

- [ ] **Step 1: 运行完整工程门禁**

Run: `npm run typecheck && npm test && npm run build`

Expected: 全部通过。重点检查 `lib/analysis.ts`、`lib/ai.ts`、源码索引、覆盖率和发布分析相关既有测试没有回归。

- [ ] **Step 2: 验证两个真实输入**

经用户确认 AI 调用与费用后：

- 对一个本地 Git 仓库指定固定 commit 生成报告；修改但未提交一个文件，确认报告 SHA 和代码仍对应原 commit，dirty warning 可见。
- 对一个小型 GitHub 公开仓库 URL 生成报告，记录实际仓库与 SHA；确认无需 GitHub App、仓库所有权、Chandler 或 MySQL，临时 clone 已清理。

不得用单元测试替代这两个真实入口的验收，也不得把未运行的真实 AI 验证写成已通过。

- [ ] **Step 3: 验收单文件 HTML**

- 将 HTML 单独复制到另一个目录，断开网络后打开；概况、功能、场景、证据和覆盖说明仍完整。
- 分别以中文和英文调用 Skill，确认交互消息、AI 内容、HTML `lang`、导航、搜索、warnings、空态与无障碍文案使用对应语言。
- 检查桌面与 390px/320px 窄屏；无整体横向滚动，长路径、长场景和代码块可读。
- 验证搜索、分类筛选、证据展开、锚点与键盘操作；禁用 JavaScript 后正文仍可阅读。
- 使用浏览器网络面板确认没有自动外部请求；GitHub permalink 只在用户点击时打开。
- 检查所有覆盖/截断/清洗 warning，不把覆盖率表述为正确率或测试覆盖率。

- [ ] **Step 4: 验证 Skill 交付**

从 `dist/codelphi-snapshot-skill/` 在至少一个已完成适配的真实宿主中运行 Skill 流程，确认 Skill 只负责调用与交付，最终产出一个 HTML。移除独立 `AI_*` 配置后仍使用该宿主当前模型完成分析，不出现另选模型或重复配置端点的步骤。对 Kimi、ZCode、WorkBuddy、Claude Code、Codex、Cursor 分别更新支持矩阵为 `supported`／`unavailable`／`unverified`；未实际验收的宿主不得标为支持。缺少宿主 AI、不可访问仓库、无有效规格和输出冲突都有明确失败，不生成虚假成功结果。

- [ ] **Step 5: 更新文档**

`docs/local-snapshot.md` 记录安装/构建、两种输入、宿主当前模型优先与 standalone 兜底、宿主支持矩阵、调用语言决定 Skill/HTML 语言、显式 `--env-file`、固定 HEAD 与 dirty 语义、AI 数据去向、HTML 内容、覆盖率和已知限制。每个宿主未开放或未验证模型接口的情况必须写成限制，不能宣称支持。`README.md` 只增加简短入口与链接，不把本地工具描述成持续分析服务。

- [ ] **Step 6: 独立审查与提交**

审查 Git 命令注入、路径逃逸、HTML XSS、临时目录清理、意外数据库调用、服务端行为回归和 Skill 分发完整性。Critical/Important 问题先补失败测试再修复。

```bash
git add docs/local-snapshot.md README.md docs/superpowers/plans/2026-11-17-local-product-snapshot-html-skill.md
git commit -m "docs: document local product snapshot skill"
```

- [ ] **Step 7: 发布后行为核对（仅在实际 push 后）**

若 `codelphi` MCP 可用，使用 `list_releases`/`get_release` 核对新 SHA；重点确认共享提取函数没有改变服务端证据清洗、重试、manual 保护、发布和覆盖率行为。MCP 不可用时明确记录未完成该项，不能用本地测试冒充 MCP 对账。

## 里程碑

### M1：仓库内可用

完成 Tasks 1–5：本地路径与公开 GitHub URL 均能生成一个离线 HTML；不需要 MySQL，不做持续分析。

### M2：Skill 可分发

完成 Task 6：Skill 包脱离 CoDelphi 源码和根 `node_modules` 可运行，Skill 只承担调用与交付；宿主能力可用时直接使用宿主当前模型，无独立 `AI_*` 前置配置。

### M3：可信验收

完成 Task 7：至少一个真实宿主的当前模型接入与 standalone 兜底、真实 Git、离线 HTML、窄屏、安全和现有服务端回归都有明确结果；文档和支持矩阵如实记录其他宿主的未验证项及能力限制。

## 非本轮事项

- 本地增量分析、历史规格、文件索引持久化和多报告比较。
- Git hook、文件监听、公开仓库轮询、自动 PR 分析。
- 私有 GitHub 仓库、GitLab/Gitee/Gitea、SSH URL、非 Git 普通目录。
- 未提交工作区的临时内容快照；本轮只提示其未被分析。
- 系统架构图、完整调用图、运行时行为证明、测试执行或正确性评分。
- 在线 HTML 托管、公开分享链接、账号权限和报告协作编辑。
- npm 公共 registry 发布、SkillHub 上架和生产部署；需要时在 M2 验收后另行决定。
- 未经核实的全宿主兼容承诺，以及通过读取其他宿主私有配置/凭据实现的“伪复用”。

## 后续可选演进（不阻塞本轮）

只有真实使用证明存在需求后再考虑：

- `--base/--head` 的变化报告，与当前现状报告分开命名和呈现。
- 可选择的本地缓存，用于降低重复快照成本；缓存不是默认产品产物。
- 固定 revision 的本地 MCP 读取面，直接读取 HTML 内嵌 JSON 或新增独立数据导出。
- 私有仓库与其他代码平台，沿用各自明确的授权和网络安全策略。
