# 全量分析行为清单与定向补漏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用确定性实现面清单、锚点核销、任务级恢复和定向补跑替代全量盲收敛，同时保持旧分析路径可回退。

**Architecture:** 新增独立 behavior-inventory 与 full-analysis 编排层；manifest 固定分析单元、锚点及执行任务，MySQL 负责任务租约、共享预算与场景映射。旧分区路径默认不变，`inventory_shadow` 只产生对照产物，`inventory` 在验收通过后才替代全量主路径。

**Tech Stack:** TypeScript、Next.js 16、Zod 4、MySQL 8/InnoDB、mysql2、Vitest 4；不新增语言解析器或统计库。

**Spec:** `docs/superpowers/specs/2026-11-19-full-analysis-behavior-inventory-design.md`

## Global Constraints

- 默认 `FULL_ANALYSIS_MODE=legacy`；`inventory_shadow` 不激活新规格，`inventory` 只能在 Task 15 的人工验收后启用。
- 首版只承诺同 revision、scope、detector registry、inventory schema 下的确定性；不做跨 revision 语义哈希。
- 主内容/辅助上下文/合计硬预算分别为 96KB/32KB/128KB；不得截断后伪装成功。
- `unitKey/anchorKey` 不依赖 AI 输出；预算拆分只新增 `taskKey/anchorFragmentKey`。
- 覆盖使用按 path 分组的闭区间并集，禁止重叠行数直接求和。
- 执行语义为 at-least-once + attempt 条件提交，不承诺 exactly-once。
- `source='manual'`、证据清洗、未变行为保真、坍缩护栏、发布变化和 1 SAU/run 用户计费契约不变。
- 增量、RC2-carry、W0-8 diff 枚举和本地快照路径不在本期改造范围内。
- 不执行生产部署、历史数据修复或生产全量重跑；每个任务完成后跑其定向测试，最终运行 `npm run typecheck`、`npm test`、`npm run build`。
- 账本反查已执行：slug=`radar`，可用快照 release 13 / sha `c0e1d0235f033005238dc07a6bcae8a02ed171f8`，明显落后于工作区且覆盖稀疏。`lib/analysis.ts` 命中「AI 结构化分析与证据校验」「手动分析触发」「分析运行与规格版本写入」；`lib/ai.ts` 命中「AI 结构化分析与证据校验」。其他计划文件未命中不代表无风险，必须用直接测试覆盖。
- 账本红线：未知证据路径继续被拒绝；同 afterSha 活跃 run 继续复用；manual 不被 generated 覆盖；非最新 run 不得激活；AI JSON 解析与非 2xx 错误语义不回归。

## Review Focus

- 重叠/相邻区间与锚点越界：覆盖必须按唯一行区间计算，Task 2 的 `unions overlapping and adjacent ranges without double counting` 与 `rejects anchors outside unit primary ranges` 必须覆盖。
- 动态注册、重复 route、匿名 handler：不得覆盖 key 或使文件退出分析，Task 3 的 `falls back without losing files for duplicate anonymous dynamic registrations` 必须覆盖。
- 空 AI 结果、共享副作用函数与不可读源码：空结果不是 no_behavior，共享副作用不能轻易归为 pure_technical，Task 9 的三项状态测试必须覆盖。
- 并发预算与过期租约：worker 不得超 maxLlmCalls，旧 attempt 不得覆盖新结果，Task 7/8 的并发与迟到提交测试必须覆盖。
- AI 改名、锚点分片和跨单元合并：身份不得依赖 feature 名，映射缺失必须回滚，Task 10/11/12 的 identity/origin/rollback 测试必须覆盖。

---

### Task 1: 身份类型与 canonical manifest

**Files:**
- Create: `lib/behavior-inventory/types.ts`
- Create: `lib/behavior-inventory/identity.ts`
- Create: `lib/behavior-inventory/manifest.ts`
- Test: `tests/behavior-inventory-manifest.test.ts`

**Interfaces:**
- Produces: `LineRange`、`CodeRange`、`BehaviorAnchor`、`BehaviorUnit`、`BehaviorExecutionTask`、`BehaviorManifest`。
- Produces: `makeUnitKey(input: BehaviorUnitLocator): string`、`makeAnchorKey(input: BehaviorAnchorLocator): string`。
- Produces: `canonicalManifest(manifest: BehaviorManifest): string`、`manifestHash(manifest: BehaviorManifest): string`。

- [ ] **Step 1: 写失败测试**

覆盖同内容不同对象 key/数组插入顺序得到相同 hash；匿名 handler 使用 `anonymous@path:line:column`；AI feature 名变化不改变 unit/anchor key；`undefined` 与显式 `null` 按统一空值规则序列化。

```ts
expect(manifestHash(reordered)).toBe(manifestHash(original));
expect(makeAnchorKey(anonymousLocator)).toContain("anonymous@src/orders.ts:12:9");
```

- [ ] **Step 2: 验证测试先失败**

Run: `npx vitest run tests/behavior-inventory-manifest.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现类型、定位符与 canonical 序列化**

对象 key 按码点排序；units/tasks/anchors 按确定性 key 排序；区间先规范化；不使用 AI 名称或内容 hash。SHA-256 只用于 manifest 完整性和数据库索引，不用于跨 revision 语义身份。

- [ ] **Step 4: 验证测试通过**

Run: `npx vitest run tests/behavior-inventory-manifest.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/behavior-inventory tests/behavior-inventory-manifest.test.ts
git commit -m "feat: add deterministic behavior inventory identities"
```

### Task 2: 区间并集、差集与子集校验

**Files:**
- Create: `lib/behavior-inventory/ranges.ts`
- Test: `tests/behavior-inventory-ranges.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CodeRange`、`LineRange`。
- Produces: `unionRanges(ranges: readonly CodeRange[]): CodeRange[]`。
- Produces: `subtractRanges(primary: readonly CodeRange[], covered: readonly CodeRange[]): CodeRange[]`。
- Produces: `rangeLineCount(ranges: readonly CodeRange[]): number`、`assertRangesWithin(inner: readonly CodeRange[], outer: readonly CodeRange[]): void`。

- [ ] **Step 1: 写失败测试**

`[10,30] + [20,40] + [35,50]` 必须得到 `[10,50]` 和 41 行；`[1,10]` 与 `[11,20]` 合并；不同 path 不合并；空/倒序区间抛错；锚点越界抛错。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-inventory-ranges.test.ts`
Expected: FAIL，函数未定义。

- [ ] **Step 3: 实现整数闭区间算法**

先按 path、startLine、endLine 排序，再合并重叠和整数相邻区间；差集返回稳定排序，禁止用长度求和推导覆盖。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/behavior-inventory-ranges.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/behavior-inventory/ranges.ts tests/behavior-inventory-ranges.test.ts
git commit -m "feat: add exact behavior range accounting"
```

### Task 3: 语义检测器与剩余实现面清单

**Files:**
- Create: `lib/behavior-inventory/detectors/types.ts`
- Create: `lib/behavior-inventory/detectors/next.ts`
- Create: `lib/behavior-inventory/detectors/generic.ts`
- Create: `lib/behavior-inventory/index.ts`
- Create: `tests/fixtures/behavior-inventory/next-route.ts`
- Create: `tests/fixtures/behavior-inventory/flask-dynamic.py`
- Test: `tests/behavior-inventory.test.ts`

**Interfaces:**
- Consumes: Task 1/2 类型、身份与区间函数；现有 `evidenceKind` 和 `ArchitectureSource` 形状。
- Produces: `BehaviorDetector { id: string; version: string; detect(source: InventorySource): BehaviorUnitDraft[] }`。
- Produces: `buildBehaviorInventory(input: BuildInventoryInput): BehaviorInventoryResult`，返回 units、diagnostics、scopeFingerprint，不生成 tasks。

- [ ] **Step 1: 写失败测试**

覆盖 Next 单文件 GET/POST、页面、公开导出、CLI/job/event 标记、权限/校验/异常区域的 implicit_review；Flask 动态装饰器、重复匿名注册和未知框架必须回退剩余单元，文件不丢失。

```ts
expect(routeUnit.anchors.filter(a => a.role === "implicit_review")).not.toHaveLength(0);
expect(result.diagnostics.fallbackInventorySuccess).toBe(true);
expect(result.units.map(u => u.primaryPath)).toContain("flask-dynamic.py");
```

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-inventory.test.ts`
Expected: FAIL，inventory 入口不存在。

- [ ] **Step 3: 实现小型检测器 registry 与兜底**

首版只实现 Next page/route + method、通用公开导出和明确 CLI/job/event 注册标记；不为大量框架增加解析器。entry 不替代内部审查；未被 behavior 覆盖的区间生成 implicit_review，动态/解析失败记录 `detectorUnsupported/detectorParseFailure/dynamicRegistrationFallback`。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/behavior-inventory.test.ts tests/behavior-inventory-ranges.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/behavior-inventory tests/behavior-inventory.test.ts tests/fixtures/behavior-inventory
git commit -m "feat: build semantic and residual behavior inventories"
```

### Task 4: 执行任务规划与双覆盖门禁

**Files:**
- Create: `lib/behavior-inventory/planner.ts`
- Create: `lib/behavior-inventory/coverage.ts`
- Test: `tests/behavior-inventory-planner.test.ts`

**Interfaces:**
- Consumes: Task 1–3 的 manifest 类型、units 和区间算法。
- Produces: `BEHAVIOR_SOURCE_BUDGETS = { primaryBytes: 96_000, contextBytes: 32_000, totalBytes: 128_000 }`。
- Produces: `planBehaviorExecutionTasks(input: PlanExecutionTasksInput): BehaviorExecutionTask[]`。
- Produces: `TaskSource { path: string; content: string; startLine: number; endLine: number; role: "primary" | "context" }` 与 `loadBehaviorTaskSources(index: OpenedRemoteSourceRevision, task: BehaviorExecutionTask): Promise<TaskSource[]>`。
- Produces: `evaluateInventoryCoverage(input: CoverageInput): InventoryCoverage`，包含 primary/anchor omissions、唯一行数和 diagnostics。

- [ ] **Step 1: 写失败测试**

超预算只新增 task/fragment key；跨分片锚点不能被单任务核销；重叠 behavior 与 implicit_review 的并集恰好等于 primary；共享服务只读取相关签名/调用区间而非在每个 route 重复全文；无法安全拆分的单元返回 unresolved diagnostic，不截断。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-inventory-planner.test.ts`
Expected: FAIL，planner 不存在。

- [ ] **Step 3: 实现任务规划和覆盖计算**

优先整锚点分组，再按 symbol/安全行区间分片；所有任务在 manifest 写入前固定。分别计算 primaryCoverage 与 anchorCoverage，不用锚点数量替代区间。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/behavior-inventory-planner.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/behavior-inventory/planner.ts lib/behavior-inventory/coverage.ts tests/behavior-inventory-planner.test.ts
git commit -m "feat: plan bounded behavior execution tasks"
```

### Task 5: MySQL 080 迁移与 insert-only manifest 持久化

**Files:**
- Create: `migrations/080_behavior_inventory.sql`
- Create: `lib/behavior-unit-receipts.ts`
- Test: `tests/behavior-unit-receipts.test.ts`

**Interfaces:**
- Consumes: Task 1 的 canonical manifest/hash。
- Produces: `insertManifestIfAbsent(execute: Execute, manifest: BehaviorManifest): Promise<void>`。
- Produces: `loadVerifiedManifest(execute: Execute, runId: number): Promise<BehaviorManifest>`；冲突抛 `inventory_version_conflict` 或 `inventory_manifest_tampered`。

- [ ] **Step 1: 写失败测试**

首次 INSERT 成功；同 run 同 hash 重入幂等；不同 manifest 禁止 UPDATE/REPLACE；恢复时篡改 JSON 或版本不一致必须失败。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-unit-receipts.test.ts`
Expected: FAIL，repository 不存在。

- [ ] **Step 3: 编写迁移与 manifest repository**

080 创建 `analysis_behavior_manifests`、`analysis_behavior_tasks`、`analysis_behavior_anchor_scenarios`、`analysis_run_budgets`，并给 `llm_call_receipts` 增加 nullable `task_key/unit_key/attempt_id/call_stage`。使用单调 BIGINT PK、InnoDB、utf8mb4、JSON 和 DATETIME(3)；长 key 保存原文并加 SHA-256 索引列，任务唯一键为 `(run_id, task_key_hash)`，关联表使用对应 hash 唯一键。tasks 索引覆盖 `(run_id,status)`、`(run_id,unit_key_hash,status)`、`(lease_expires_at,status)`。

- [ ] **Step 4: 验证通过并检查迁移依赖**

Run: `npx vitest run tests/behavior-unit-receipts.test.ts && npm run typecheck`
Expected: PASS；迁移只依赖既有 analysis_runs/spec_scenarios 表，不修改历史行。

- [ ] **Step 5: Commit**

```bash
git add migrations/080_behavior_inventory.sql lib/behavior-unit-receipts.ts tests/behavior-unit-receipts.test.ts
git commit -m "feat: persist immutable behavior analysis manifests"
```

### Task 6: LLM 回执携带任务与尝试身份

**Files:**
- Modify: `lib/ai.ts:384-390`
- Modify: `lib/billing/cost-receipt.ts:28-40,80-117`
- Test: `tests/billing-cost-receipt.test.ts`

**Interfaces:**
- Produces: 可选 `taskKey/unitKey/attemptId/callStage`，同时扩展 `LlmBillingContext` 与 `LlmCallReceiptInput`；旧调用不传时全部写 NULL。
- Produces: `loadAttemptLlmUsage(runId: number, attemptId: string): Promise<AttemptLlmUsage>`，聚合该尝试的真实 token、费用、usage_status/pricing_status，供 Task 7 结算。
- `callStage` 限定为 `describe | judge | semantic_repair | product_summary`。

- [ ] **Step 1: 写失败测试**

断言新调用的四个字段进入 INSERT，旧分区/W0-8 调用不传字段仍生成 NULL；超时/失败回执同样携带 task/attempt；loadAttemptLlmUsage 分别返回 known、unknown、unpriced，缺回执不得当作零成本。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/billing-cost-receipt.test.ts`
Expected: FAIL，当前 INSERT 没有对应列。

- [ ] **Step 3: 实现透传，保持现有 best-effort 与 unknown-usage 语义**

不将回执写失败改成主链路失败，不改变 SAU 结算。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/billing-cost-receipt.test.ts tests/analysis-run.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/ai.ts lib/billing/cost-receipt.ts tests/billing-cost-receipt.test.ts
git commit -m "feat: link llm receipts to behavior task attempts"
```

### Task 7: 共享运行预算的原子预留与结算

**Files:**
- Create: `lib/behavior-run-budget.ts`
- Test: `tests/behavior-run-budget.test.ts`

**Interfaces:**
- Produces: `reserveBehaviorBudget(input: BudgetReservationInput): Promise<BudgetReservation>`。
- Produces: `settleBehaviorBudget(input: BudgetSettlementInput): Promise<void>`、`releaseUnusedBehaviorBudget(reservationId: string): Promise<void>`。
- Produces: `reserveProductSummaryBudget(runId: number): Promise<BudgetReservation>`。
- Errors: `behavior_budget_exceeded`、`behavior_budget_usage_unknown`。

- [ ] **Step 1: 写失败测试**

三个 worker 面对剩余 3 次调用、每任务最大预留 2 次时，只有一个能先预留；实际使用 1 次并释放未用预留后另一任务可继续。覆盖 summary 独立预留、过期任务重新预留、token/费用 unknown 硬门禁和 overshoot 记录。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-run-budget.test.ts`
Expected: FAIL，预算模块不存在。

- [ ] **Step 3: 实现条件 UPDATE 预算账本**

禁止 SELECT 余额后无条件写入；调用次数严格原子预留，token/费用按上界预留、真实回执结算，任务终态释放未发生部分。旧 attempt 预留在结算或租约回收前保持占用。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/behavior-run-budget.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/behavior-run-budget.ts tests/behavior-run-budget.test.ts
git commit -m "feat: reserve shared behavior analysis budgets atomically"
```

### Task 8: 执行任务租约与条件提交

**Files:**
- Modify: `lib/behavior-unit-receipts.ts`
- Test: `tests/behavior-task-leases.test.ts`

**Interfaces:**
- Produces: `claimBehaviorTask(input: ClaimTaskInput): Promise<ClaimedBehaviorTask | null>`。
- Produces: `renewBehaviorTaskLease(input: LeaseInput): Promise<void>`。
- Produces: `commitBehaviorTaskResult(input: CommitTaskResultInput): Promise<boolean>`。
- Produces: `markBehaviorTaskFailure(input: TaskFailureInput): Promise<void>`。

- [ ] **Step 1: 写失败测试**

两个 worker 只有一个领取成功；未过期租约不可抢占；过期领取生成新 attempt_id；旧 attempt 提交返回 false 且不覆盖 result_json；成功任务恢复时不重新执行。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-task-leases.test.ts`
Expected: FAIL，租约函数不存在。

- [ ] **Step 3: 实现原子领取、续租与提交**

领取和提交都使用 run_id + task_key_hash + attempt_id + lease_owner/status 条件；崩溃恢复只处理过期任务，已完成结果保持不动。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/behavior-task-leases.test.ts tests/behavior-unit-receipts.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/behavior-unit-receipts.ts tests/behavior-task-leases.test.ts
git commit -m "feat: add resumable behavior task leases"
```

### Task 9: 单元复述/判定提取与受控内部实现结论

**Files:**
- Create: `lib/behavior-unit-ai.ts`
- Create: `lib/behavior-unit-extraction.ts`
- Test: `tests/behavior-unit-extraction.test.ts`

**Interfaces:**
- Consumes: `requestStructuredCompletion`、Task 6 billing metadata、Task 4 tasks。
- Produces: `describeBehaviorTaskPrompt(task: BehaviorExecutionTask, sources: TaskSource[]): string`。
- Produces: `judgeBehaviorTaskPrompt(input: JudgePromptInput): string`。
- Produces: `extractBehaviorTask(input: ExtractBehaviorTaskInput): Promise<BehaviorTaskExtractionResult>`。

- [ ] **Step 1: 写失败测试**

prompt 不含「1-5」或显著性数量帽；共享 DB 写入/外部 API/权限/事件函数不得仅因被调用而判 pure_technical；空 features、无证据 reviewed_internal、候选全清洗均为 unresolved；covered_elsewhere 缺关联为 unresolved。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-unit-extraction.test.ts`
Expected: FAIL，提取模块不存在。

- [ ] **Step 3: 实现双步 prompt、Zod 与状态推导**

复述逐 behavior/implicit_review 区域，不判断是否值得写；判定输出 extracted/reviewed_internal/unresolved 和 internalKind。沿用 `sanitizeEvidence` 与实际读取 allowSet，任何截断或无证据结论不得成为 no_behavior。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/behavior-unit-extraction.test.ts tests/analysis-evidence.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/behavior-unit-ai.ts lib/behavior-unit-extraction.ts tests/behavior-unit-extraction.test.ts
git commit -m "feat: extract and classify behavior task anchors"
```

### Task 10: 分片聚合与局部场景身份

**Files:**
- Create: `lib/behavior-unit-state.ts`
- Test: `tests/behavior-unit-state.test.ts`

**Interfaces:**
- Produces: `assignLocalScenarioKeys(input: LocalScenarioInput): LocalScenarioKeyAssignment[]`。
- Produces: `aggregateBehaviorUnitStatus(input: UnitAggregationInput): BehaviorUnitStatus`。
- Produces: `buildAnchorScenarioLinks(input: AnchorLinkInput): AnchorScenarioLink[]`。

- [ ] **Step 1: 写失败测试**

localScenarioKey 不含 AI feature/reference；同一持久化结果按证据和规范化行为文本分配 001…；锚点两个分片未完成前不能 extracted；重试整体替换旧局部集合；多锚点可关联同一局部场景。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-unit-state.test.ts`
Expected: FAIL，状态模块不存在。

- [ ] **Step 3: 实现聚合和确定性 ordinal**

先清洗、规范化、行为等价去重并汇总同一 anchor 的全部分片，再按 path/startLine/category/context/action/outcome 排序。只承诺同一持久化结果内稳定，不引入语义哈希。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/behavior-unit-state.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/behavior-unit-state.ts tests/behavior-unit-state.test.ts
git commit -m "feat: aggregate behavior anchors and local scenario identities"
```

### Task 11: 合并过程传播 originKeys

**Files:**
- Modify: `lib/spec-diff.ts:5-17`
- Modify: `lib/extraction-merge.ts:28-138`
- Create: `lib/behavior-result-merge.ts`
- Test: `tests/extraction-merge.test.ts`
- Test: `tests/behavior-result-merge.test.ts`

**Interfaces:**
- Produces: `SpecScenario.originKeys?: string[]`，每个值是一个 localScenarioKey；不进入 prompt、展示文本或行为等价判断。
- Produces: `mergeBehaviorTaskResults(chunks: ExtractionChunk[]): BehaviorMergedResult`，包含 AnalysisResult 与 anchor links。
- Existing `mergeChunkResults(chunks, onStats?)` 签名保持兼容。

- [ ] **Step 1: 写失败测试**

重复场景合并时 originKeys 求并集；多锚点共同支撑一个场景不丢来源；引用重编号不改变 origin；无 origin 的旧分区结果逐字段保持旧行为。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-result-merge.test.ts tests/extraction-merge.test.ts`
Expected: 新测试 FAIL，旧测试可用于确认现状。

- [ ] **Step 3: 实现 origin 传播**

在 addScenarioToGroup 的保留、去重和变体折叠路径都合并 originKeys；不得把 origin 纳入 scenarioBehaviorEqual 或 featureVariantSimilar。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/behavior-result-merge.test.ts tests/extraction-merge.test.ts tests/merge-variant-features.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/spec-diff.ts lib/extraction-merge.ts lib/behavior-result-merge.ts tests/extraction-merge.test.ts tests/behavior-result-merge.test.ts
git commit -m "feat: preserve behavior origins through deterministic merges"
```

### Task 12: 激活门禁、摘要降级与事务内最终映射

**Files:**
- Create: `lib/behavior-activation.ts`
- Modify: `lib/spec-versions.ts:172-186,307-373`
- Modify: `lib/analysis.ts:192-243`
- Test: `tests/behavior-activation.test.ts`
- Test: `tests/spec-versions.test.ts`
- Test: `tests/analysis-persistence.test.ts`

**Interfaces:**
- Produces: `evaluateBehaviorActivationGate(input: ActivationGateInput): ActivationGateResult`。
- Produces: `resolveProductDescription(input: ProductDescriptionInput): Promise<{ product: AnalysisResult["product"]; status: "generated" | "preserved" | "unavailable" }>`。
- `insertSpecVersion` 额外返回 `scenarioIdByLocalKey: ReadonlyMap<string, number>`。
- `saveResult` 接受可选 behavior links，并在同一事务回填 `analysis_behavior_anchor_scenarios.final_scenario_id`。

- [ ] **Step 1: 写失败测试**

pending/running/failed/unresolved、primary/anchor omission、证据或合并检查失败均拒绝激活；摘要失败分别 generated/preserved/unavailable，语言切换不保留旧语种；任一 origin 没有最终 spec_scenario ID 时事务回滚，旧激活规格不变。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-activation.test.ts tests/spec-versions.test.ts tests/analysis-persistence.test.ts`
Expected: 新增断言 FAIL。

- [ ] **Step 3: 实现门禁和最终映射**

insertFeatures 在每个 spec_scenario INSERT 后读取 insertId 并建立 localScenarioKey 映射；missing mapping 必须抛错回滚。摘要预留独立于任务预算，首分析失败可空简介，行为规格本身不因此失败。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/behavior-activation.test.ts tests/spec-versions.test.ts tests/analysis-persistence.test.ts tests/analysis-run.test.ts`
Expected: PASS，manual 与 assertLatestRun 红线不回归。

- [ ] **Step 5: Commit**

```bash
git add lib/behavior-activation.ts lib/spec-versions.ts lib/analysis.ts tests/behavior-activation.test.ts tests/spec-versions.test.ts tests/analysis-persistence.test.ts
git commit -m "feat: gate and persist complete behavior analysis results"
```

### Task 13: 全量编排、legacy/shadow/inventory 三模式

**Files:**
- Create: `lib/full-analysis.ts`
- Modify: `lib/env.ts`
- Modify: `lib/analysis.ts:404-576`
- Test: `tests/full-analysis.test.ts`
- Test: `tests/analysis-convergence.test.ts`

**Interfaces:**
- Produces: `fullAnalysisMode(): "legacy" | "inventory_shadow" | "inventory"`，默认 legacy。
- Produces: `behaviorAnalysisConcurrency()` 读取 `ANALYSIS_BEHAVIOR_CONCURRENCY`，默认 4、clamp 1–16。
- Produces: `behaviorAnalysisBudget()` 读取 `ANALYSIS_BEHAVIOR_MAX_LLM_CALLS`、`ANALYSIS_BEHAVIOR_MAX_TOTAL_TOKENS`、`ANALYSIS_BEHAVIOR_MAX_COST_AMOUNT`、`ANALYSIS_BEHAVIOR_COST_CURRENCY`；缺省为无对应上限，不用 0 表示无上限。
- Produces: `runInventoryFullAnalysis(input: InventoryFullAnalysisInput, options: { activate: boolean }): Promise<InventoryFullAnalysisOutcome>`。
- Outcome 提供现有下游需要的 result、coverage、enumerationMetrics、passInfos、mergeStats 和 behavior links。

- [ ] **Step 1: 写失败测试**

legacy 完全走旧分区/收敛；inventory_shadow 旧结果唯一激活且新调用使用 platform_shadow；inventory 只走任务路径、不执行旧收敛；incremental/RC2-carry 不进入新全量编排；单元失败不调用 saveResult。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/full-analysis.test.ts tests/analysis-convergence.test.ts`
Expected: 新三模式测试 FAIL，旧 convergence 默认配置仍应保持。

- [ ] **Step 3: 实现编排和路径选择**

组合 Task 3–12 接口；恢复先 loadVerifiedManifest，首次运行才扫描并 insert manifest。任务调度固定为 reserveBehaviorBudget → claimBehaviorTask；claim 失败立即释放刚取得的预留，预算不足不得领取租约。legacy 主流程不改；shadow 在旧流程完成后 best-effort 执行且不覆盖结果；inventory 只替代 `affectedKeys===null` 的全量提取。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/full-analysis.test.ts tests/analysis-run.test.ts tests/analysis-convergence.test.ts tests/manual-analysis.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/full-analysis.ts lib/env.ts lib/analysis.ts tests/full-analysis.test.ts tests/analysis-convergence.test.ts
git commit -m "feat: add inventory-based full analysis orchestration"
```

### Task 14: 恢复语义、完整性账本与管线文档

**Files:**
- Modify: `lib/analysis-recovery.ts:14-24`
- Modify: `lib/completeness-ledger.ts`
- Modify: `lib/analysis-coverage.ts`
- Modify: `docs/analysis-pipeline.md`
- Test: `tests/analysis-recovery.test.ts`
- Test: `tests/completeness-ledger.test.ts`

**Interfaces:**
- Produces: `InventoryEnumerationSummary` 作为 `BehavioralEnumerationMetrics` 的可选 inventory details；旧 W0-8 字段和状态不变。
- Recovery 对 inventory run 复用 manifest/result_json/lease；`inventory_version_conflict` 不自动重建 manifest。

- [ ] **Step 1: 写失败测试**

孤儿 inventory run 不重新扫描、不清空成功任务；版本冲突不循环补跑；账本记录 running/coarse/implicit/fallback/lease/budget/summary 指标；旧 W0-8 回执字段保持兼容。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/analysis-recovery.test.ts tests/completeness-ledger.test.ts`
Expected: 新增断言 FAIL。

- [ ] **Step 3: 更新恢复、账本与现行文档**

删除「所有孤儿 run 都没有中间产物」的过时注释；sourceCoverage 对新路径要求 range omissions 为零，旧回执历史语义不变。文档明确三模式、双重覆盖、at-least-once、预算和激活条件。

- [ ] **Step 4: 验证通过**

Run: `npx vitest run tests/analysis-recovery.test.ts tests/completeness-ledger.test.ts tests/analysis-coverage.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/analysis-recovery.ts lib/completeness-ledger.ts lib/analysis-coverage.ts docs/analysis-pipeline.md tests/analysis-recovery.test.ts tests/completeness-ledger.test.ts
git commit -m "feat: audit and recover inventory-based analysis runs"
```

### Task 15: 配对 benchmark、shadow 验收与主路径切换门禁

**Files:**
- Create: `lib/behavior-benchmark.ts`
- Create: `scripts/measure-inventory-analysis.ts`
- Create: `docs/benchmark/frozen/behavior-inventory-v1.schema.json`
- Create: `docs/benchmark/frozen/behavior-inventory-v1.md`
- Test: `tests/behavior-benchmark.test.ts`
- Modify: `docs/analysis-pipeline.md`

**Interfaces:**
- Produces: `pairedRecallDelta(pairs: readonly PairedBehaviorOutcome[]): number`。
- Produces: `newcombePairedInterval(pairs: readonly PairedBehaviorOutcome[], confidence = 0.95): ConfidenceInterval`。
- Produces: `evaluateBehaviorNonInferiority(input: RepoComparison[]): BenchmarkVerdict`，逐仓 `LowerCI(Delta)>-0.03`，宏平均点估计不低于 -0.03，样本不足为 inconclusive。
- Script 只执行显式指定的 shadow/离线对照，不激活规格、不部署生产。

- [ ] **Step 1: 写统计失败测试**

使用同一批配对二元结果验证 delta、Newcombe 区间、严格大于阈值、30 条不自动等于功效充分；确认不能用两个独立 Wilson 区间替代；误报分母按各路径实际评估输出行为计算，unmatched 不伪造配对。

- [ ] **Step 2: 验证失败**

Run: `npx vitest run tests/behavior-benchmark.test.ts`
Expected: FAIL，统计模块不存在。

- [ ] **Step 3: 实现配对统计与测量脚本**

每仓冻结至少 30 条人工行为，记录 behaviorId、源码定位、行为描述、外部结果和必要证据；保留各路径自身 Wilson 区间，召回差值使用 Newcombe 配对区间。误报、证据、拆分/合并、未决、成本、耗时分别输出。

- [ ] **Step 4: 验证统计与全项目检查**

Run: `npx vitest run tests/behavior-benchmark.test.ts && npm run typecheck && npm test && npm run build`
Expected: 全部 PASS；构建产物之外不留下临时日志或测量输出。

- [ ] **Step 5: 冻结人工预标并执行 shadow 对照**

在 CoDelphi、`expressjs/express`、`pallets/flask` 和冻结 Superset fixture 上，由未查看新旧输出的评审先冻结行为清单。若任一仓 LowerCI 未高于 -0.03、过程门禁失败或证据/误报越界，结论为 inconclusive/failed，停止，不切换 `FULL_ANALYSIS_MODE=inventory`。

- [ ] **Step 6: 验收通过后更新文档与提交**

只有 Step 5 明确通过才记录 inventory 可启用；否则文档只保留 shadow 能力和未通过原因。不得在任务中自行执行生产模式切换。

```bash
git add lib/behavior-benchmark.ts scripts/measure-inventory-analysis.ts docs/benchmark/frozen/behavior-inventory-v1* docs/analysis-pipeline.md tests/behavior-benchmark.test.ts
git commit -m "test: add paired behavior benchmark for inventory analysis"
```

## 完成后的用户审阅点

实施到 Task 14 时只交付可恢复的清单与 shadow 能力。Task 15 的人工 benchmark 结果必须再次交给用户审阅；是否把生产或开发环境切到 `inventory` 是单独决定，不由实现 agent 根据场景数或单次 shadow 结果自行批准。
