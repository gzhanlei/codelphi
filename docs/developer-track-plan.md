# 开发者动线开发计划（M5–M9）

> 2026-11-06 制定，落实 [产品规划](product-roadmap.md) 阶段二。所有代码锚点已逐条核实（文件:行号以当前工作区为准）。
>
> **完成定义（每个 WP 通用）**：`npm run typecheck`、`npm test`、`npm run build` 全绿；migration 按编号追加；不触碰 manual 保护红线（`lib/analysis.ts:50-79` 语义不弱化）。

## 0. 深挖后修正的两个规划假设

1. **证据链接目前实际不可点击**。渲染层支持 `item.url`（`components/evidence-links.tsx:5-9`），但没有任何 blob URL 生成代码——AI schema 的 `url` 是 optional（`lib/ai.ts:9`）且 prompt 不要求，实际存储基本只有 `{path, startLine?}`（`tests/analysis-persistence.test.ts:8`）。→ 新增 **WP0 证据 URL 生成器**，同时反哺现有产品页（用户可见改进）。
2. **GitHub App 纯只读确认**：`default_permissions` 仅 contents/metadata read、`default_events` 仅 `["push"]`（`lib/github-app.ts:21,35`）；全仓库无任何 pulls API 调用；通用 REST fetcher（`githubFetch`/`appApiFetch`）存在但**模块私有未导出**（`lib/github.ts:22-30`、`lib/github-app.ts:72-84`）。→ M5 含权限迁移 runbook 与 REST helper 导出。

## 1. 推荐执行顺序与并行度

| 序 | WP | 规模 | 粗估（人日） | 可并行 |
|---|---|---|---|---|
| 1 | WP0 证据 URL 生成器 + REST helper 导出 | S | 1–2 | — |
| 2 | M6 功能→实现聚合视图 | S | 2 | 与 WP0 后任意 WP 并行 |
| 3 | M7 测试骨架导出 | S | 1–2 | 同上 |
| 4 | **M5 反向索引 + PR 预演**（5a→5b→5c） | L | 7–10 | 5a 可提前；5b 需 App 权限迁移 |
| 5 | M8 漂移提醒 | M | 3–4 | 核心部分可与 M5 并行（文件不相交） |
| 6 | M9 增量分析 | L | 8–12 | 压轴，等 5a 索引经真实数据验证 |

单人串行总计 ≈ 22–30 人日（约 4–6 周）。M6/M7 先行拿快赢并验证 WP0；M5 是阶段核心；M9 最后动引擎。

---

## WP0 证据 URL 生成器 + GitHub REST helper（共享底座）

**新增 `lib/evidence-url.ts`**：
- `evidenceUrl(repo: {owner, name}, sha: string, item: Evidence): string | null`——生成 `https://github.com/{owner}/{name}/blob/{sha}/{path}#L{start}-L{end}`；path 非法（`..`、不以字母数字开头）返回 null。
- sha 选择规则：有已成功 `latestRun.after_sha` 用之（钉到被分析的版本），否则仓库默认分支 head。调用方负责传入。

**接入点（同 WP 内完成，页面上全部证据变可点击）**：
- `components/evidence-links.tsx`：新增可选 prop `urlFor?: (item) => string | null`；无 prop 时维持现状（避免破坏其他调用点）。
- `lib/product-details.ts:69` 附近的消费链路：把 repository（owner/name）+ latestRun.afterSha 传给 `SpecWorkspace` → `FeatureDetail` → `ScenarioCard`/`BehaviorChangeItem` 的证据渲染。

**导出 REST helper**（不改变行为，只加导出与薄封装）：
- `lib/github.ts`：导出 `githubFetch`（或新增 `githubRest(path, access)` 包装）；新增 `getPullRequestFiles(repo, number, access): Promise<ChangeFile[]>`（`GET /repos/{o}/{r}/pulls/{n}/files`，分页聚合）与 `upsertIssueComment(repo, number, body, commentId?, access)`（`POST/PATCH /repos/{o}/{r}/issues/{n}/comments`）。
- `lib/code-hosting/adapter.ts`：接口增加 `getPullRequestFiles` / `upsertIssueComment`（可选方法，默认抛不支持）；`github-provider.ts` 实现。为 M12 多托管留缝。

**测试**：URL 生成（含非法 path）、`getPullRequestFiles` 分页（`vi.stubGlobal("fetch")` 模式，仿 `tests/github-api.test.ts`）。

---

## M6 功能 → 实现聚合视图

**数据**：无新表。在 `getProductDetails`（`lib/product-details.ts:45-78`）返回值上新增每功能的 `evidenceFiles: {path, lineCount, scenarios: reference[]}[]`：
- 聚合范围 = 本功能场景 + 子功能场景的 `scenarios.evidence`（`evidenceItems` 解析，`lib/evidence.ts:3-14`），按 path 去重、一级目录分组排序；行区间合并计数。

**UI**：`components/feature-detail.tsx:22-32` 头部新增「实现分布」区（折叠列表：目录 → 文件 → 关联场景 reference 徽标），链接走 WP0 生成器。场景卡片既有 evidence 渲染同步换用生成器。

**测试**：聚合纯函数（多场景同文件去重、空 evidence、子功能归并）+ `FeatureDetail` 渲染快照（`renderToStaticMarkup` 模式，仿 `tests/product-overview-component.test.ts`）。

**验收**：任选 dogfooding 产品，功能页一屏看到「改这个功能要动哪些文件」，点击直达 GitHub 对应 revision 的行区间。

---

## M7 场景 → 测试骨架导出

**新增**：
- `lib/scenario-export.ts`：`toGherkin(features, scenarios): string`（Feature/Rule 按功能两级树；情境→Given、操作→When、结果→Then；`@HP-1 @EC-2` 作 tag）；`toMarkdownChecklist(...): string`。
- `GET /api/products/[slug]/export/tests?format=gherkin|markdown`：鉴权同现有产品 API（组织成员校验），`Content-Disposition` 下载。

**测试**：导出纯函数（空场景、reference 正则 `/^(?:HP|EC|ER)-\d+$/` 兜底）、route 鉴权拒绝（匿名/他组织）。

**验收**：产品页一键下载 `.feature` 文件，可直接放进 Cucumber/Playwright 项目且 tag 可筛选。

---

## M5 反向影响索引 + PR 预演 ⭐

### 5a 反向索引（纯后端，可先行）

- **Migration `017_spec_file_index.sql`**：`spec_file_index(id, repository_id BIGINT, spec_version_id BIGINT, path VARCHAR(500), feature_id BIGINT NULL, spec_feature_id BIGINT NULL, scenario_id BIGINT NULL, KEY idx_repo_path (repository_id, path))`——`spec_feature_id` 保稳定键链接，`feature_id/specenario_id` 链到活表（可能已被删，读侧容忍 NULL 失配）。
- **重建逻辑**：`lib/spec-file-index.ts` `rebuildSpecFileIndex(connection, run, specVersionId, result)`——遍历本次 `spec_features/spec_scenarios` 的 evidence JSON 提取 path（复用 `specFeatureKey` 归一化）；在 `saveResult` 事务内（`lib/analysis.ts:122` `insertSpecVersion` 之后）执行：`DELETE WHERE repository_id=?` + 批量 INSERT。事务性保证索引与快照版本一致。
- 仅对新分析生效（历史数据可用 `npm run analyze -- <slug>` 重跑回填）。

### 5b App 权限迁移 + 事件分支

- **Manifest 更新**（`lib/github-app.ts:21,35`）：`default_permissions` 增加 `pull_requests: write`（评论走 issues API，`pull_requests: write` 已覆盖）；`default_events` 增加 `"pull_request"`。manifest 变更意味着**新装 App 生效；已装 App 需走权限升级流程**。
- **迁移 runbook（写入 README「GitHub App 迁移」小节，沿用既有排错记录）**：
  1. 本地/测试仓库建新 App 验证 manifest → ping → PR 评论全链路；
  2. 生产 App：GitHub App Settings → Permissions 单独提升（installe 需重新批准）；Settings → Webhook 勾选 `pull_request` 事件；
  3. 验证双 secret 验签仍过（`resolveGitHubWebhookSecrets` 候选机制，`lib/github-webhook.ts:44-49`）；
  4. 回滚预案：提升是增量的，出问题可只关代码侧分支开关（env `PR_PREVIEW_ENABLED`，默认 false——**5c 合入后仍由开关灰度**）。
- **Webhook 分支**（`lib/github-webhook.ts:57-58` 之前插入）：
  - 新 payload schema：`pull_requestSchema = {action, pull_request: {number, head: {sha}, base: {ref}}, repository: {full_name}}`，只处理 `action ∈ {opened, synchronize}`；
  - `WebhookDependencies`（`lib/github-webhook.ts:27-31`）扩展为可判别返回：`{kind: "push", runId} | {kind: "pr-preview", payload} | {kind: "ignored"}`；
  - **路由分发改造**（`app/api/webhooks/github/route.ts:15-16`）：`after()` 按 kind 分流——push → `runAnalysis(runId)`；pr-preview → `runPrPreview(payload)`；route 需新增对 `runPrPreview` 的导入（此处是 route 唯一实质改动）。
- **`lib/pr-preview.ts`**：`runPrPreview(payload)`——查仓库注册与 installation token（`resolveGitHubToken`）→ `getPullRequestFiles` → 查 `spec_file_index`（按 path 集合，取最新 `spec_version_id` 的索引行）→ 交集非空则渲染评论 → `upsertIssueComment`。

### 5c 评论渲染与去重

- 评论体：产品名 + 「此 PR 触碰 N 个文件，涉及 M 个功能」+ 按功能分组的场景清单（`HP-n/EC-n/ER-n` + WP0 风格证据路径）+ 免责行「预演基于最近一次成功分析，合并后以实际分析为准」。
- 去重：评论首行嵌隐藏 marker `<!-- codelphi-pr-preview:{full_name}#{number} -->`；先 `GET /issues/{n}/comments` 查 marker，命中则 PATCH 原评论，否则 POST。
- 开关与节流：env `PR_PREVIEW_ENABLED`（`lib/env.ts` 惯例新增读取函数）；同 PR 60 秒内 synchronize 合并处理可后置优化，首版接受逐 commit 更新。
- 边界：fork PR（head 仓库未安装）——files API 走 base 仓库即可，评论照常；未注册仓库/无索引 → 静默 202。

**测试**：schema 分支（opened/synchronize/其他 action 忽略）、索引重建 SQL 断言（mock `Execute` 片段匹配模式，仿 `tests/spec-editor-persistence.test.ts`）、交集计算纯函数、评论去重（先查后 PATCH）、route 分流（`vi.hoisted` mock `next/server` 的 after，仿 `tests/github-webhook-receiver-route.test.ts`）。

**验收**：dogfooding 仓库开 PR 改一个已有功能证据文件 → PR 出现预演评论且链接可点；追加 commit → 同一评论被更新；关掉 `PR_PREVIEW_ENABLED` → 事件被忽略且 push 分析不受影响。

---

## M8 规格漂移提醒

- **Migration `018_spec_drift.sql`**：`features` 与 `scenarios` 各加 `stale_since DATETIME NULL`、`stale_change_id BIGINT NULL`（活表直接加列，编辑器按主键更新，无稳定键问题）。
- **标记时机**：`saveResult` 事务内（`insertSpecVersion` 返回 changes 后）：对每条 `spec_changes.feature_key` 用 `specFeatureKey(features.name)` 反查活表 feature（及其场景），凡 `source='manual'` 且本次被触及 → 置 stale 列。纯 SQL 可完成（JSON 不参与匹配，按 name 归一化）。
- **展示**：产品页 `getProductDetails` 统计 stale 数量 → `ProductView` 头部徽标「N 条人工规格可能过时」；spec 视图对应功能卡片加「可能过时」角标（`components/feature-detail.tsx`）。
- **清除时机**：`lib/spec-editor-service.ts` 的 `updateFeature`（:109-115）与 `updateScenario`（:163-168）保存成功后同事务内置空 stale 列。
- **通知集成**：摘要文案追加一段——**留接口不实现**（`lib/notifications` 尚不存在，属 M1/阶段一；接口签名先定义 `driftNotices(productId)` 备用）。
- **红线自检**：stale 标记是元数据，不改变 `source`、不参与 `IF(source='generated',...)` 覆盖逻辑，不产生 tombstone。

**测试**：标记 SQL（mock 模式）、编辑保存清除、徽标渲染、红线回归（manual 条目在含 stale 状态下仍不被自动分析覆盖——直接复用现有 analysis-persistence 用例加断言）。

**验收**：人为改某功能相关代码触发行为变化 → 功能卡片出现「可能过时」；编辑保存该功能 → 角标消失。

---

## M9 增量分析引擎

**前置门槛**：5a 索引已在 ≥3 个真实产品上跑过 ≥50 次分析且失配率可接受；否则不启动。

### 设计

- **模式开关**：`products.analyze_mode ENUM('full','incremental') DEFAULT 'full'`（Migration `019`）；CLI 与「立即分析」按钮均可显式指定。
- **受影响集计算**：进入 `performAnalysis` 后，若 incremental：diff 文件 ∩ `spec_file_index` → 受影响 `stable_key` 集合；以下任一条件**回退 full**：索引为空、受影响功能 > 全部功能的 60%、diff 文件 > 200。
- **切片收窄**：`createSlicePlanner`（`lib/analysis.ts:180`）传入 scope = 受影响功能的证据目录集合（而非全仓 scope 目录）；预算常量不变。
- **AI 提示收窄**：`analyzeWithAI` 增量模式提示词改为「只分析以下功能的当前行为」；输出 schema 不变（仍整仓形态，但只含受影响功能）。
- **Generated carry-forward**（核心新逻辑，`lib/spec-versions.ts`）：`insertSpecVersion` 增加参数 `carried: SpecFeature[]`——取上一 `spec_versions` 快照中 stable_key ∉ 受影响集的 generated 条目（manual 合并路径 `loadManualSpec`/`loadManualTombstones` 逻辑**不动**）；`mergeSpecSources` 改为三分合并（AI 新析 + carried + manual）。diff 语义不变：carried 条目与上一版相同 → 不产生 `spec_changes`，发布页自然无噪音。
- **不变量**：`assertEvidence` 只校验 AI 输出（carried 条目在产生时已校验过，不重复校验；其 path 可能已陈旧属已知可接受盲区，记录在案）；`saveResult` 的 description write-once（`lib/analysis.ts:118-121`）不动。
- **影子验证**：feature flag `INCREMENTAL_SHADOW=true` 时同 push 双跑（增量落库、全量只对比不落库），比较两次 spec_change 集合的一致率；放行标准 ≥98%（对齐规划文档门槛），结果写入 `analysis_runs.error_message` 旁路字段或新表 `019` 内加 `incremental_shadow_report JSON`。
- **回滚**：`analyze_mode` 改回 full 即回全量，无数据迁移风险（快照结构不变）。

### 测试

- 三分合并纯函数（AI∩manual 冲突、carried 稳定键匹配、carried+manual 同 key 优先级与现行为一致）；
- 回退条件矩阵（空索引/超阈值）；
- carry-forward 后 `spec_changes` 仅含受影响变化（persistence 模式全链路用例）；
- 影子对比报告生成；
- 红线回归：增量模式下 manual 功能永不被 AI 覆盖或丢失（现有用例扩展增量路径）。

**验收**：dogfooding 仓库连续 20 次 push：增量成本（AI read calls + tokens，`analysis_runs` 可加耗时/token 记录列）较全量基线降幅 ≥60%；行为变化产出与全量影子一致率 ≥98%；任一异常自动回退且有日志。

---

## 2. 里程碑间依赖图

```
WP0 ──→ M6 ──┐
   └──→ M7 ──┼──（无相互阻塞，可穿插）
             │
WP0 → 5a(索引) → 5b(权限+事件) → 5c(评论)      ← M6 的聚合查询后续可切换到索引表（可选优化，非必须）
        │
        └──→ M8（标记逻辑独立，仅「通知摘要接口」等 M1）
        └──→ M9（硬依赖 5a 真实数据验证）
```

## 3. 风险与待决问题

| 风险 | 应对 |
|---|---|
| App 权限升级需要 installer 重新批准，期间 PR 评论静默失败 | `PR_PREVIEW_ENABLED` 默认关闭灰度；失败只记日志不进 analysis_runs 错误态 |
| PR 评论打扰开发者 | 只在交集非空时评论；原地更新不刷屏；评论底部固定「如何关闭」说明行 |
| stable_key 基于名称归一化（`specFeatureKey`），功能改名 → 链接失效/新建键 | 接受：预演评论链接到产品 spec 页 + 名称锚点，不做永久 ID 系统（记录为已知取舍） |
| carried 条目证据指向旧 revision 的行号 | 记录为已知盲区；M6 聚合视图标注「基于最近分析版本」 |
| M9 影子双跑成本翻倍 | 影子只对 1–2 个 dogfooding 产品开启，达标即关 |
| 单人节奏，M5+M9 连续大件容易疲劳 | M6/M7 快赢前置；M5 拆 5a/5b/5c 三个可独立合并的 PR |

## 4. 提交策略

每个 WP 独立 PR（拆分粒度 = 上表行）；migration 与依赖它的代码同 PR；PR 描述附对应里程碑编号（M5-5a 等）；全部合入 main 后由既有部署流程上线（部署不属本计划范围，遵循 README 流程）。
