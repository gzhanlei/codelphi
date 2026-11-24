# MCP `map_change` 变更导航 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增只读 `map_change`，把自然语言变更意图转换为带身份解析、证据状态、Git 路径生命周期、候选动作和确定性预算的改动地图。

**Architecture:** 纯函数模块负责身份、状态、生命周期、聚合与预算；托管适配器提供未截断的 commit relation/diff；加载器编排当前/历史检索、原始树存在性和有界生命周期读取；MCP server 只做鉴权、参数校验和紧凑输出。现有分析 prompt 预算、`statPath` 和其他 MCP 工具行为保持不变。

**Tech Stack:** TypeScript、Next.js App Router、MySQL 8、Vitest、Zod、现有 MCP JSON-RPC、GitHub/GitLab API、remote-source-index。

**Spec:** `docs/superpowers/specs/2026-11-24-mcp-map-change-design.md`

## Global Constraints

- 工具只读；不修改规格、生产数据或远端资源，不执行生产部署，不新增模型调用、migration 或依赖。
- `stableKey + reference` 只能唯一定位当前 active 场景，不能单独证明跨版本身份；功能级 `feature_aliases` 只能用于 Related。
- `current_observed` 必须同时满足 active、原始树路径存在、逐证据 freshness 有效；snapshot 与 analyzedSha 不一致或文件清单 capped 时为 unknown。
- Historical direct + 文件存在但没有当前职责证据只能 `inspect`；生命周期只沿可比较且连接 snapshot 的 Git 祖先链建立。
- 生命周期预算：16 releases、32 次托管请求、并发 4、8 秒 deadline；超限不得推断残缺链。
- 响应上限：reasons 5、constraints 20、historicalChanges 10、gaps 10、最终紧凑 JSON 49,152 UTF-8 字节；全局去重排序后分页。
- 既有 `getChangeContext` 的 120 文件/56KB patch 预算只服务 AI 分析，不得用于 map_change 生命周期或 freshness；既有调用方行为不变。
- 既有 `statPath` 的 pruned→null 读取语义不变；新增原始树存在性接口，pruned 文件仍存在，无法判定返回 null。
- 沿用组织级防枚举、现有 MCP raw 响应和错误语义；只有 `map_change` 的 `content[0].text` 使用紧凑 JSON。
- 每个任务按 TDD 执行；最终运行 `npm run typecheck`、`npm test`、`npm run build`，不得删除失败测试或放宽门禁。

## Blast Radius and Regression Redlines

已对计划中的 20 个现有路径执行 `lookup_by_files?view=risk`：218 条 raw、54 条 canonical 场景，账本快照 `93201dbedcbbbdbe2a0ffa48235746fdd4bf7e2b`。

- `lib/github-source.ts`：现有 120 文件 round-robin 与 56KB patch 预算是 AI 分析契约，新元数据通道必须绕过而不是改变它。
- `lib/mcp/freshness.ts`：现有 MCP 搜索/反查仍沿用当前接口；显式 analyzedSha 和完整性状态只能扩展，不能改变默认结果。
- `lib/remote-source-index/index.ts`：`statPath` 继续把 pruned 当作不可读；只有新 `pathExists` 使用原始树语义。
- `lib/mcp/server.ts`：既有工具列表以外的 raw 响应、pretty text、鉴权、防枚举与发布对账行为不变。
- push 后对账锚点：`mcp 只读工具面与 api key 鉴权`、`mcp 输出投影与对账`、`github 代码读取与变更上下文`、`github 源码候选与变更预算`、`github 仓库列表与源码快照`，以及本次实际修改路径。
- `lib/code-hosting/types.ts`、`docs/coding-agent-mcp.md`、`AGENTS.md`、`README.zh-CN.md`、`tests/mcp-server.test.ts`、`tests/github-source.test.ts` 未被账本覆盖，必须人工审查并跑 targeted tests；空覆盖不代表无风险。

## Review Focus

- 同名场景、歧义 reference、功能级别名：不得错误授予 Direct（Task 1 的唯一解析/降级测试）。
- snapshot 与 freshness 锚点分叉、120 文件截断：不得把未知当成 fresh（Task 3 的状态测试）。
- diverged 分支、revert、rename、删除后重新引入：不得生成错误 create（Task 4 的生命周期测试）。
- 多来源、预算自引用、预算截断分页：不得丢最强来源、超 48 KiB 或无法推进 offset（Task 5 的最大向量测试）。
- pruned/scope 外路径、托管 API 超时与限流：不得把未知当不存在或长时间阻塞（Tasks 3、4、6 的降级测试）。

---

### Task 1: 身份解析、创建意图与当前证据纯函数

**Files:**
- Create: `lib/mcp/map-change-types.ts`
- Create: `lib/mcp/map-change-match.ts`
- Create: `lib/mcp/map-change-evidence.ts`
- Test: `tests/mcp-map-change-match.test.ts`
- Test: `tests/mcp-map-change-evidence.test.ts`

**Interfaces:**
- Produces: `MatchTier`、`MatchBasis`、`EvidenceSource`、`Validity`、`SuggestedAction`、`CandidateRole`、`MapChangeCandidate`、`MapChangeResponse`、`MapChangeGap`、`SecondaryCount`。
- Produces: `normalizeMapChangePath(path): string`、`classifyCandidateRole(path): CandidateRole`、`extractScenarioIdentity(intent, features, scenarios): ScenarioIdentity | null`、`behaviorTextHash(scenario): string`、`classifyMatch(basis): MatchTier`、`classifyCreationIntent(intent): "explicit" | "not_explicit"`。
- Produces: `evaluateCurrentEvidence(input): { validity: Validity; existsAtSnapshot: boolean | null }`。

- [ ] **Step 1: 写失败测试**

覆盖完整功能标识 + reference 唯一解析、零/多命中、ASCII 边界、前导零、非 active；同 reference 不同文本不得跨版本 Direct；功能级 alias 只能 Related；`exact_behavior_text` 的 NFKC、`\p{White_Space}`、null/空字符串、字段顺序和 SHA-256 固定向量；创建词表及否定优先；role 与规范化路径；active × exists × evidenceFreshness 全矩阵。

```ts
expect(classifyMatch({ kind: "lexical", terms: ["turnstile"] })).toBe("lexical_only");
expect(classifyCreationIntent("不要添加 Turnstile")).toBe("not_explicit");
expect(evaluateCurrentEvidence({ active: true, existsAtSnapshot: true, evidenceFreshness: "stale" }).validity).toBe("stale");
expect(evaluateCurrentEvidence({ active: true, existsAtSnapshot: null, evidenceFreshness: "fresh" }).validity).toBe("unknown");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/mcp-map-change-match.test.ts tests/mcp-map-change-evidence.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯函数与类型**

按 Spec §4–§7 定义判别联合。`behaviorTextHash` 使用 Node `crypto.createHash("sha256")`；`extractScenarioIdentity` 只在全产品唯一命中当前 active 场景时返回；路径拒绝绝对路径和 `..` 越界，role 使用 Spec 的首命中优先级。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/mcp-map-change-match.test.ts tests/mcp-map-change-evidence.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/mcp/map-change-types.ts lib/mcp/map-change-match.ts lib/mcp/map-change-evidence.ts tests/mcp-map-change-match.test.ts tests/mcp-map-change-evidence.test.ts
git commit -m "feat: add map change identity and evidence contracts"
```

---

### Task 2: GitHub/GitLab 未截断提交元数据适配器

**Files:**
- Modify: `lib/code-hosting/types.ts`
- Modify: `lib/code-hosting/adapter.ts`
- Modify: `lib/code-hosting/github-provider.ts`
- Modify: `lib/code-hosting/gitlab-provider.ts`
- Modify: `lib/github.ts`
- Modify: `lib/github-source.ts`
- Modify: `lib/gitlab.ts`
- Test: `tests/github-source.test.ts`
- Test: `tests/gitlab-provider.test.ts`
- Create: `tests/code-hosting-metadata.test.ts`

**Interfaces:**
- Produces: `CommitRelation`、`CommitDiff`、`CommitFileStatus`。
- Produces: `CodeHostingAdapter.getCommitRelation(repo, baseSha, targetSha, access)` 与 `getCommitDiff(repo, beforeSha, afterSha, access)`，签名和返回结构严格按 Spec §8.1。

- [ ] **Step 1: 写失败测试**

GitHub compare fixture 覆盖 `ahead/behind/diverged`、`merge_base_commit`、parents、`previous_filename` 和 >120 文件不截断；GitLab merge_base 与 compare fixture 覆盖祖先方向、parents、`old_path/new_path`、added/deleted/renamed/modified。既有 `getChangeContext` 测试仍断言 120 文件和 patch 预算不变。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/code-hosting-metadata.test.ts tests/github-source.test.ts tests/gitlab-provider.test.ts`
Expected: FAIL，新方法不存在。

- [ ] **Step 3: 实现元数据方法与适配器注册**

在 `code-hosting/types.ts` 新增独立类型，不改变 `ChangeFile`。GitHub 使用 compare 原始字段；GitLab 使用 merge_base、commit 和 compare/diff 原始字段。新方法不读取 patch/blob，不调用 `budgetedChangeFiles`；不支持完整事实的 provider 抛出明确不可用错误，由上层降级。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/code-hosting-metadata.test.ts tests/github-source.test.ts tests/gitlab-provider.test.ts`
Expected: 全部 PASS，且现有 ChangeContext 契约无回归。

- [ ] **Step 5: Commit**

```bash
git add lib/code-hosting lib/github.ts lib/github-source.ts lib/gitlab.ts tests/code-hosting-metadata.test.ts tests/github-source.test.ts tests/gitlab-provider.test.ts
git commit -m "feat: expose complete commit metadata for map change"
```

---

### Task 3: freshness 锚点/完整性与原始树存在性

**Files:**
- Modify: `lib/mcp/freshness.ts`
- Modify: `lib/remote-source-index/index.ts`
- Modify: `lib/remote-source-index/types.ts`
- Create: `tests/mcp-freshness-map-change.test.ts`
- Modify: `tests/remote-source-index.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `getCommitDiff`。
- Produces: `loadLedgerFreshness(productId, execute, deps, options?: { analyzedSha?: string })`；`FreshnessData.filesComplete: boolean`。
- Produces: `OpenedRemoteSourceRevision.pathExists(path): Promise<boolean | null>`。

- [ ] **Step 1: 写失败测试**

覆盖显式 analyzedSha 不随 committed_at 最新 release 漂移、返回锚点不一致可检测、完整 diff 的 behavioral paths、capped/旧通道 `filesComplete=false`。树测试覆盖普通 blob、pruned vendor/lock 文件存在、非 blob 不存在、scope 越界和树预算错误返回 null。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/mcp-freshness-map-change.test.ts tests/remote-source-index.test.ts`
Expected: FAIL，显式锚点/完整性或 `pathExists` 不存在。

- [ ] **Step 3: 实现扩展且保持默认兼容**

`loadLedgerFreshness` 在传入 analyzedSha 时以该 SHA 和当前分支比较，并通过 Task 2 完整 diff 计算；未传入时保持现有选择器和结果。`filesComplete` 只描述文件列表完整性，不扩展 `LedgerFreshness` 对外结构。

`pathExists` 使用 `findEntry` 的原始树条目，blob 即使 pruned 也返回 true；scope、预算和读取错误返回 null。`statPath` 不改。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/mcp-freshness-map-change.test.ts tests/remote-source-index.test.ts tests/mcp-server.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/mcp/freshness.ts lib/remote-source-index/index.ts lib/remote-source-index/types.ts tests/mcp-freshness-map-change.test.ts tests/remote-source-index.test.ts
git commit -m "feat: align map change freshness and tree existence"
```

---

### Task 4: Git 生命周期、动作矩阵与有界读取

**Files:**
- Create: `lib/mcp/map-change-history.ts`
- Create: `lib/mcp/map-change-history-loader.ts`
- Test: `tests/mcp-map-change-history.test.ts`
- Test: `tests/mcp-map-change-history-loader.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 的匹配、创建意图、适配器元数据。
- Produces: `buildPathLifecycle(events, snapshotSha): PathLifecycle`、`decideSuggestedAction(input): { action: SuggestedAction; validity: Validity }`。
- Produces: `readPathLifecycles(input): Promise<{ lifecycles: PathLifecycle[]; gaps: MapChangeGap[] }>`，内部执行 16/32/4/8s 预算和不可变缓存。

- [ ] **Step 1: 写失败测试**

覆盖同 SHA 去重、祖先/后代/diverged、无法连接 snapshot、revert、原子 rename、删除后重新引入；历史 direct + 当前存在但无职责证据只能 inspect；creationIntent 与强身份独立；16 release/32 请求/并发 4/8 秒上限、缓存命中和超限降级。

```ts
expect(decideSuggestedAction({ matchTier: "historical_direct", existsAtSnapshot: true, hasCurrentDutyEvidence: false }).action).toBe("inspect");
expect(decideSuggestedAction({ matchTier: "historical_direct", existsAtSnapshot: false, lifecycle: ["added", "deleted"], creationIntent: "explicit" }).action).toBe("create_candidate");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/mcp-map-change-history.test.ts tests/mcp-map-change-history-loader.test.ts`
Expected: FAIL，生命周期模块不存在。

- [ ] **Step 3: 实现生命周期与预算执行器**

只用 `getCommitRelation/getCommitDiff`，不读取 committedAt 排链。rename 保留同一原子事件；无法确认关系时返回 gap 并降级。缓存 key 包含 repositoryId 与有序 base/target SHA 坐标，只缓存成功的不可变结果；用注入 clock/scheduler 测试 deadline 和并发。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/mcp-map-change-history.test.ts tests/mcp-map-change-history-loader.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/mcp/map-change-history.ts lib/mcp/map-change-history-loader.ts tests/mcp-map-change-history.test.ts tests/mcp-map-change-history-loader.test.ts
git commit -m "feat: build bounded git lifecycles for map change"
```

---

### Task 5: 多来源聚合、稳定分页与 48 KiB 硬预算

**Files:**
- Create: `lib/mcp/map-change.ts`
- Create: `lib/mcp/map-change-budget.ts`
- Test: `tests/mcp-map-change.test.ts`
- Test: `tests/mcp-map-change-budget.test.ts`

**Interfaces:**
- Consumes: Tasks 1、4 的候选和动作。
- Produces: `aggregateCandidates(inputs): MapChangeCandidate[]`、`paginateMapChange(result, { limit, offset }): MapChangeResponse`。
- Produces: `enforceMapChangeBudget(response): MapChangeResponse`、`serializeMapChangeResponse(response): string`。

- [ ] **Step 1: 写失败测试**

覆盖每条 reason 独立 matchTier/matchBasis/source、候选最高等级、reasonCounts、全量去重排序后分页、跨页无重复遗漏、预算后 `offset + returnedCount` 推进。最大合法向量验证必要信任信封 + 一个最小候选；`responseBytes` 不动点包含自身；任何摘要/数组/候选裁剪都设置 truncated。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/mcp-map-change.test.ts tests/mcp-map-change-budget.test.ts`
Expected: FAIL，聚合/预算模块不存在。

- [ ] **Step 3: 实现聚合与预算**

按 Spec §9–§10 先构造最小信任信封和每候选最强 reason，再补辅助 reasons/constraints/history/gaps。使用 `Buffer.byteLength(JSON.stringify(...), "utf8")` 迭代不动点；不得超过 49,152 字节，不得用丢来源伪造完整性。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/mcp-map-change.test.ts tests/mcp-map-change-budget.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/mcp/map-change.ts lib/mcp/map-change-budget.ts tests/mcp-map-change.test.ts tests/mcp-map-change-budget.test.ts
git commit -m "feat: aggregate and bound map change responses"
```

---

### Task 6: 当前/历史检索与 map_change 加载器

**Files:**
- Modify: `lib/spec-search.ts`
- Create: `lib/mcp/map-change-loader.ts`
- Test: `tests/mcp-map-change-loader.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 的全部纯函数、元数据、freshness、原始树和生命周期接口。
- Produces: `searchReleaseHistoryForLifecycle(productId, query, execute): Promise<ReleaseBehaviorResult[]>`，保留召回集合完整增删改，不做摘要兴替去重。
- Produces: `loadMapChange(input): Promise<MapChangeResponse>`，输入包含 product/repository、intent、includeHistory、limit、offset、execute 和托管访问上下文。

- [ ] **Step 1: 写失败测试**

覆盖当前无命中但历史有结果、历史不可用保留当前、includeHistory=false 不产生 no_history、快照不可用全 inspect、snapshot/freshness 锚点不一致、coverage 状态、历史不去重、生命周期超预算降级、空结果不编造路径。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/mcp-map-change-loader.test.ts`
Expected: FAIL，加载器或完整历史查询不存在。

- [ ] **Step 3: 实现加载编排**

复用 `searchSpec`/`queryVariants` 做 Intent Retrieval，独立执行身份解析。当前 release 固定 `is_current=1, analysis_run_id DESC, id DESC`；coverage 使用 `loadCoverageReceipt`，freshness 显式传 snapshot.sha，原始树在一次调用内只打开一次。历史召回与生命周期读取分离，失败只增加机器可读 gaps。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/mcp-map-change-loader.test.ts tests/mcp-map-change-history-loader.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/spec-search.ts lib/mcp/map-change-loader.ts tests/mcp-map-change-loader.test.ts
git commit -m "feat: load current and historical map change evidence"
```

---

### Task 7: MCP 协议、紧凑输出与工作流文档

**Files:**
- Modify: `lib/mcp/server.ts`
- Modify: `tests/mcp-server.test.ts`
- Modify: `docs/coding-agent-mcp.md`
- Modify: `AGENTS.md`
- Modify: `app/mcp/page.tsx`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Consumes: Task 6 的 `loadMapChange`。
- Produces: MCP `map_change` 工具定义和 JSON-RPC 分发。

- [ ] **Step 1: 写协议失败测试**

断言工具注册、intent/includeHistory/limit/offset 校验、越权 `{}`、非法参数 `INVALID_PARAMS`、紧凑 `content[0].text` 与 structuredContent 一致、既有工具仍 pretty、只读和既有 raw 响应不变。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/mcp-server.test.ts`
Expected: FAIL，`map_change` 未注册。

- [ ] **Step 3: 接入 MCP 并更新文档**

注册工具和 callTool 分支；只对该工具使用 `JSON.stringify(result)`。文档改为「map_change 导航 → lookup_by_files 反查 → reconcile_release 对账」，说明候选不完备、空结果、快照、历史和预算边界；README 工具计数按实际 16 只读 + 1 反馈更新。

- [ ] **Step 4: 运行协议与相关测试**

Run: `npx vitest run tests/mcp-server.test.ts tests/mcp-map-change-loader.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/mcp/server.ts tests/mcp-server.test.ts docs/coding-agent-mcp.md AGENTS.md app/mcp/page.tsx README.md README.zh-CN.md
git commit -m "feat: expose map change through mcp"
```

---

### Task 8: Turnstile 端到端夹具与全量验证

**Files:**
- Create: `tests/fixtures/map-change-turnstile.ts`
- Create: `tests/mcp-map-change-e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7 的全部接口。

- [ ] **Step 1: 写端到端失败测试**

夹具覆盖历史组件新增→修改→删除、当前表单/路由、配置/文档/测试、过期 active 场景和移除原因。断言当前/历史不混淆、历史存在无职责只 inspect、满足全部条件才 create、rename/分支异常降级、辅助入口保留、紧凑响应不超过预算。

- [ ] **Step 2: 运行测试并修复契约偏差**

Run: `npx vitest run tests/mcp-map-change-e2e.test.ts`
Expected: 初始 FAIL；只修实现，不放宽身份、生命周期或预算规则，最终 PASS。

- [ ] **Step 3: 运行 P0-A/B targeted tests**

Run: `npx vitest run tests/mcp-map-change-*.test.ts tests/code-hosting-metadata.test.ts tests/github-source.test.ts tests/gitlab-provider.test.ts tests/remote-source-index.test.ts tests/mcp-freshness-map-change.test.ts tests/mcp-server.test.ts`
Expected: 全部 PASS。

- [ ] **Step 4: 运行项目标准验证**

Run: `npm run typecheck && npm test && npm run build`
Expected: 全部通过。记录并修复本次引入的问题； unrelated 既有失败如实报告，不删测试。

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/map-change-turnstile.ts tests/mcp-map-change-e2e.test.ts
git commit -m "test: verify map change lifecycle end to end"
```

---

### Task 9: P0-C 独立增量价值试点

**Files:**
- Create: `docs/superpowers/pilots/2026-11-24-map-change-value-pilot.md`

**Interfaces:**
- Consumes: 已通过 P0-A/B 的 `map_change`。

- [ ] **Step 1: 冻结独立任务与对照口径**

选择历史能力恢复和跨功能变更任务；使用独立上下文，保持相同仓库快照、任务描述、模型与推理配置，对照组不得看到实验组导航结果。

- [ ] **Step 2: 执行配对任务并记录净价值**

分别记录有效增量发现、错误增量发现、重复发现、漏报、决策促成、额外探索成本、计划时间、源码搜索次数、候选采用率和当前/历史混淆。

- [ ] **Step 3: 独立评审与停止判定**

由不知道输出来源的评审依据代码/测试确认发现。只有净收益为正且至少一项独立确认的增量发现或决策改善才支持扩大投入；普通 CRUD 不作为主要证明。

- [ ] **Step 4: 保存报告并 Commit**

报告注明任务、快照、模型、隔离方式、证据、成本和样本限制。

```bash
git add docs/superpowers/pilots/2026-11-24-map-change-value-pilot.md
git commit -m "docs: evaluate map change incremental discovery"
```

---

## Final Reconciliation

若用户随后 push，使用本次最终 SHA 调用 `wait_for_release`、`list_releases` 和 `reconcile_release`：意图包含新 `map_change` 功能及以上 Blast Radius 锚点；核对既有 MCP、GitHub 预算、freshness 和发布对账没有计划外变化。未经用户明确要求，不执行 push 或生产部署。
