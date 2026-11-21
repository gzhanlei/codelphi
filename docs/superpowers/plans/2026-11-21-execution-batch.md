# Execution Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 inventory 证明模型、task 独立结果和激活门禁的前提下，通过可恢复、可对账的双步 execution batch 降低全量分析模型请求数与墙钟时间。

**Architecture:** 现有 manifest/task planner 保持不变，新增确定性 batch plan set、attempt/member/request 持久化、双阶段原始响应恢复和 task 独立校验提交。生产默认仍为 `task` 模式；先完成双步 batch 和恢复验收，再做并发基准，最后以独立 flag 实验单步融合。

**Tech Stack:** TypeScript 5.8、Next.js 16、MySQL 8 / mysql2、Zod 4、Vitest 4、现有腾讯云 MySQL 与 LLM gateway。

**Spec:** `docs/superpowers/specs/2026-11-21-execution-batch-design.md`

## Global Constraints

- 不修改 unit / anchor / fragment / task 身份、覆盖证明、证据 allowSet、确定性聚合或 activation gate。
- 自动分析不得覆盖 `source = 'manual'` 的功能或场景。
- 使用现有腾讯云 MySQL 8；不引入 PostgreSQL、本地数据库容器、ORM 或新依赖。
- 默认 `ANALYSIS_BEHAVIOR_EXECUTION_MODE=task`；融合默认 `ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE=describe_judge`。
- 同一 batch attempt 的 Judge 与 Describe 使用相同成员、源码和 T/R 映射；任何成员变化或模型重试创建新 attempt/reservation。
- 原始响应先完整持久化再解析；parser 不兼容不得触发新模型调用。
- task 未提交不等于费用未发生；usage/provider 结果未知不得按零成本处理。
- 真实 AI benchmark 只使用 scratch 数据库，需另行确认模型调用预算；不执行生产部署、DNS、Webhook 或 Docker 操作。
- 每个 commit 前运行 `npm run typecheck && npm test && npm run build`；各任务先运行自己的定向测试。
- 每个 Task 提交前对实际修改文件再次执行 `lookup_by_files`；未覆盖文件必须人工审查代码路径并补 targeted regression，不能以账本返回空作为无回归证明。

## Review Focus

1. **重复/未知请求与回执补全**：同一实际请求只能有一条 receipt，但允许 usage 从 unknown 受控补全；由 Task 4 的 request/receipt 测试覆盖。
2. **T/R 映射或 planner/parser 版本漂移**：恢复必须拒绝错误解释且不得重新调用模型；由 Task 2、3、6、10 覆盖。
3. **响应截断、数据库截断与部分有效 JSON**：不得把完整外层 JSON 或部分成功伪装成 task 成功；由 Task 4、5、7 覆盖。
4. **恢复 worker 与旧 task lease 竞争**：batch 处理权和 task 提交资格分别 fencing；由 Task 6、8、10 覆盖。
5. **主 batch 已结算但 repair 崩溃**：不得重复主请求、重复提交或提前激活；由 Task 8、10 覆盖。

## Behavior Ledger Impact and Reconciliation Anchors

当前会话未暴露 `codelphi` MCP；已通过同一套只读 `lookupFilesImpact` 对 slug `radar` 反查 10 个计划修改文件。账本当前仅覆盖 `lib/ai.ts` 与 `lib/analysis.ts`，其余管线文件为 uncovered，不能据此推断无行为影响。

回归红线：

- `AI 结构化分析与证据校验`：`lib/ai.ts` 的 HP-1 / EC-1 / ER-2；`lib/analysis.ts` 的 ER-1。
- `分析运行与规格版本写入`：`lib/analysis.ts` 的 HP-1 / EC-1 / ER-1。
- `手动分析触发`：`lib/analysis.ts` 的 EC-1。

每次 push 后使用 `list_releases` / `get_release` 或以上 stableKey + changed paths 执行 `reconcile_release`。发现计划外证据或激活行为变化必须回查。

## Assumptions

- v1.0 设计可作为计划基线；Task 2 的六类契约与 migration 评审通过是实质编码门禁。
- 下一可用 migration 是 `081_execution_batch.sql`；若执行时已出现更高编号，顺延并同步计划。
- 官方统计基线 = Task 11 配对基准 task 模式臂的实测画像；画像缺失的阶段耗时/usage 标 unknown，不得反推或填造。
- 真实 benchmark 使用固定 commit、scratch MySQL、相同模型配置和独立 run；不以单次运行宣称稳定提升。
- 未来执行每个 Task 的 commit 步骤需遵循用户当时的 Git 授权；本计划本身不执行 commit。

## Task Dependency Graph

```text
Task 1 Baseline → Task 2 Contracts/Schema → Task 3 Planner
Task 2 → Task 4 Requests/Receipts → Task 5 Protocol
Task 3 + Task 5 → Task 6 Attempt State → Task 7 Task Extraction
Task 7 → Task 8 Orchestration → Task 10 Fault Injection
Task 10 → Task 11 Batch Benchmark → Task 12 Concurrency → Task 13 Fused Experiment
Task 9 Progress：独立 UX 任务，在 Task 11 证明收益后实施，不阻塞 Task 10/11/12。
```

设计阶段映射：T0=Task 1，T1=Task 2，T2=Task 3，T3=Task 5，T4=Task 7，T5=Tasks 4/6/8/9，T6=Task 10，T7=Task 11，T8=Task 12，T9=Task 13。

---

### Task 1: 通用 run 画像聚合与冻结 benchmark 协议

**Files:**
- Create: `lib/execution-batch/baseline.ts`
- Create: `scripts/execution-batch-baseline.ts`
- Create: `tests/execution-batch-baseline.test.ts`
- Create: `docs/benchmark/execution-batch-v1.md`
- Create on real results only: `artifacts/execution-batch/run-baseline.json`

**Interfaces:**
- Produces: `summarizeExecutionBaseline(input: BaselineInput): BaselineSummary`；输出按 `describe / judge / semantic_repair / product_summary / other` 分类的 calls、tokens、cost、unknownUsage 和任务状态。
- Produces: CLI `npx tsx scripts/execution-batch-baseline.ts --run-id <runId> --output artifacts/execution-batch/run-baseline.json`；对任意已完成 run 实测画像。
- 统计基线锚点：Task 11 配对基准的 task 模式臂（同 commit/manifest/模型的全量真实 run）即官方统计基线；无历史 run 画像可比，缺失观测标 unknown。
- Frozen quality gates: `NON_INFERIORITY_MARGIN=-0.03`、`MAX_MACRO_FALSE_POSITIVE_RISE=0.03`、`MAX_MACRO_EVIDENCE_SUPPORT_DROP=0.02`、`MIN_PAIRED_BEHAVIOR_SAMPLES=30`，达到样本下限不宣称功效充分；墙钟北极星=同规模全量 20 分钟挑战目标。

- [ ] **Step 1: Write failing aggregation tests**

`tests/execution-batch-baseline.test.ts` 必须覆盖：
- `classifies describe judge repair retry and unknown usage separately`：两条 describe、一条 judge、一条 repair、一条 timeout unknown，不能用 `2 × taskCount` 代替真实计数。
- `does not invent latency or zero cost for missing receipts`：缺 duration/usage 时输出 `null` 和原因，不写 0。
- `counts only extracted and no_behavior as successful completions`：unresolved 不进入 R1/R2/R3 分母。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-baseline.test.ts`
Expected: FAIL，模块 `../lib/execution-batch/baseline` 不存在。

- [ ] **Step 3: Implement baseline aggregation and read-only CLI**

实现：

```ts
export function summarizeExecutionBaseline(input: BaselineInput): BaselineSummary;
```

CLI 使用 `dotenv/config` 和 `defaultExecute`，不读取或打印硬编码凭证文件。查询指定 run 的 tasks、manifest、runs、receipts；报告分为 A「指定 run 的实测事实」与 B「后续 benchmark 新增观测」。保留 P50/P90/P99 可计算项，缺失的队列/推理耗时明确标 `unavailable`，不得从总时长或 task 数反推。

- [ ] **Step 4: Freeze benchmark protocol before looking at outcome comparisons**

`docs/benchmark/execution-batch-v1.md` 固定相同 commit/manifest/模型、请求/token/费用/墙钟四类独立指标，以及过程门禁失败直接 failed。统计协议同时冻结：

- 基本单位是冻结人工 behavior，不是生成的 task/region/scenario 数；同一 behavior ID 在两条路径配对。
- 逐仓使用 95% Newcombe 配对差值区间（method 10），宏平均按仓简单平均；不把全部样本直接合并成一个大比例。
- 普通、residual、大 task 分层分别报告并分别执行门禁；每层样本 <30 为 inconclusive，达到 30 不等于功效充分。
- LowerCI > -0.03 才能判该仓非劣；UpperCI < -0.03 为 inferior/failed；区间跨阈值为 inconclusive，不得判通过。
- 宏平均误报上升 >0.03 或证据支持下降 >0.02 为 failed；缺误报/证据会计为 inconclusive。
- 两名不知路径来源的评审独立标注，分歧由第三名盲评裁决；标签冻结后才允许揭盲和比较。
- 统计基线锚点 = Task 11 配对基准的 task 模式臂实测；墙钟北极星 = 同规模全量 20 分钟挑战目标，未达不调整统计口径。

- [ ] **Step 5: Verify unit tests and run real baseline separately**

Run: `npm run test:direct -- tests/execution-batch-baseline.test.ts`
Expected: PASS。

经 scratch DB 与只读权限确认后运行 CLI，对任意已完成 run 产出实测画像。官方统计基线 JSON 待 Task 11 的 task 模式臂完成后由同一 CLI 产出；没有实测数据时不用估算报告替代。

- [ ] **Step 6: Run global gate and commit**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS。

```bash
git add lib/execution-batch/baseline.ts scripts/execution-batch-baseline.ts tests/execution-batch-baseline.test.ts docs/benchmark/execution-batch-v1.md artifacts/execution-batch/run-baseline.json
git commit -m "chore: freeze execution batch performance baseline"
```

---

### Task 2: 六类契约、共享类型、identity 与 migration

**Files:**
- Create: `migrations/081_execution_batch.sql`
- Create: `lib/execution-batch/types.ts`
- Create: `lib/execution-batch/identity.ts`
- Create: `lib/execution-batch/persistence.ts`
- Create: `scripts/execution-batch-migration-smoke.ts`
- Create: `tests/execution-batch-identity.test.ts`
- Modify: `docs/superpowers/specs/2026-11-21-execution-batch-design.md`

**Interfaces:**
- Produces: `BatchPlan`、`BatchAttempt`、`BatchAttemptMember`、`BatchRequest`、`BatchRequestStage`、`BatchExecutionPhase`、`BatchBudgetUpperBound`、`BatchChatMessage = { role: "system" | "user"; content: string }`。
- Produces: `BatchExecutionAllocation = { batchPlans, fallbackAssignments, planSetFingerprint }`；`FallbackAssignment = { taskKey, reason: "oversized" | "blank_fragment" | "unsupported_task_shape" }`。
- Produces: `BatchRequestOutcome = "prepared" | "dispatch_started" | "response_received" | "response_persisted" | "confirmed_not_sent" | "failed" | "outcome_unknown" | "persistence_failed"`。
- Produces: `makeBatchKey`、`makeBatchRequestKey`、`makeOrderedRegionAliases`、`batchFingerprint`、`sha256Utf8`。
- Produces: `withBatchTransaction<T>(fn: (execute: Execute) => Promise<T>): Promise<T>`。
- Constants: `BATCH_PLANNER_VERSION="1"`、`BATCH_PROMPT_VERSION="1"`、`BATCH_SCHEMA_VERSION="1"`、`BATCH_PARSER_VERSION="1"`、`MAX_BATCH_RESPONSE_BYTES=4_000_000`。

- [ ] **Step 1: Freeze the six logical contracts before choosing SQL or TypeScript shapes**

先在设计文档中评审并冻结：完整 batch/fallback 分配、attempt/member/request 关联、成员冻结与新 attempt 重试、request/receipt 身份、batch processing 与 task lease 双重 fencing、parser 兼容和 task payload 无损转换。此步骤只修改设计契约，不创建 migration；六者未全部确定不得进入 Step 2。

- [ ] **Step 2: Write failing identity and migration contract tests**

覆盖：
- `derives stable batch and request identities`：相同规范输入 hash 相同，stage/sequence 不同 request key 不同。
- `persists every anchor fragment in R order`：三个 fragments 映射 R1/R2/R3，数组顺序不被 canonical object 排序改变。
- `migration contains plan attempt member request and receipt identity tables`：检查五张表、plan set ready 字段、`llm_call_receipts.request_key` 唯一索引和 MEDIUMTEXT。
- `migration uses mysql compatible ddl`：不包含 JSONB、PostgreSQL 语法或历史表 UPDATE。

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-identity.test.ts`
Expected: FAIL，identity/migration 尚不存在。

- [ ] **Step 4: Implement types, canonical identity and transaction helper**

签名：

```ts
export function makeBatchKey(input: BatchIdentityInput): string;
export function makeBatchRequestKey(input: { batchAttemptUuid: string; stage: BatchRequestStage; sequence: number }): string;
export function makeOrderedRegionAliases(task: BehaviorExecutionTask): BatchRegionAlias[];
export function batchFingerprint(value: unknown): string;
export function withBatchTransaction<T>(fn: (execute: Execute) => Promise<T>): Promise<T>;
```

Canonicalization 只对 object keys 排序；数组保持业务顺序。`withBatchTransaction` 沿用 mysql2 connection 的 begin/commit/rollback/release，不新增全局事务框架。

- [ ] **Step 5: Add migration and close six contract checklists**

Migration 包含 plan_sets（含 fallback assignments）、plans、attempts、members、requests，以及 receipts 的可空 `request_key/request_fingerprint/duration_ms`；request key 全局唯一，member 的 request task attempt 唯一。设计文档明确六类契约已映射到这些字段和后续测试，不把状态标为已冻结，直到本 Task 评审完成。

- [ ] **Step 6: Verify identity tests and scratch migration**

Run: `npm run test:direct -- tests/execution-batch-identity.test.ts`
Expected: PASS。

在明确指向空 scratch MySQL 的环境运行 `npm run db:migrate && npx tsx scripts/execution-batch-migration-smoke.ts`，确认 081 生效，并实测 request_key 全局唯一、member task attempt 唯一、逻辑外键、MEDIUMTEXT 边界和事务 rollback；不得对生产库执行验证性 migration。

- [ ] **Step 7: Run global gate and commit**

Run global gate，然后：

```bash
git add migrations/081_execution_batch.sql lib/execution-batch/types.ts lib/execution-batch/identity.ts lib/execution-batch/persistence.ts scripts/execution-batch-migration-smoke.ts tests/execution-batch-identity.test.ts docs/superpowers/specs/2026-11-21-execution-batch-design.md
git commit -m "feat: add execution batch identity and persistence contracts"
```

---

### Task 3: 确定性 planner 与 plan set 两阶段发布

**Files:**
- Create: `lib/execution-batch/planner.ts`
- Create: `lib/execution-batch/plans.ts`
- Create: `tests/execution-batch-planner.test.ts`
- Create: `tests/execution-batch-plans.test.ts`

**Interfaces:**
- Consumes: Task 2 identity/types/transaction。
- Produces: `planBehaviorExecutionBatches(input: PlanBatchesInput): BatchExecutionAllocation`，同时返回 batch plans 与 fallback assignments。
- Produces: `publishBehaviorBatchPlanSet(execute, input): Promise<BatchPlanSet>`、`loadReadyBehaviorBatchAllocation(execute, runId): Promise<BatchExecutionAllocation>`。
- Initial limits: 4 tasks、32,000 UTF-8 primary bytes、24 regions；超出单 task 原预算或含空白 fragment 的 task 留给现有单 task 路径。

- [ ] **Step 1: Write failing planner and publication tests**

Planner：
- `packs small same file residual tasks without merging task identities`。
- `does not renumber T aliases after an unbatchable task`。
- `assigns every manifest task exactly once across batch and fallback`：无遗漏、无双重归属。
- `keeps oversized blank fragment and unsupported shapes on stable fallback routes with stable reasons`。
- `includes batch and fallback assignments in a stable plan set fingerprint`。
- `is deterministic across equivalent input ordering`。

Publication：
- `only ready plan set is executable`。
- `publishes building set after count uniqueness and fingerprint validation`。
- `rejects missing extra or reordered plan members`。
- `does not rebuild an old plan set with a new planner version`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-planner.test.ts tests/execution-batch-plans.test.ts`
Expected: FAIL，planner/plans 不存在。

- [ ] **Step 3: Implement deterministic measurement and greedy packing**

签名：

```ts
export function planBehaviorExecutionBatches(input: PlanBatchesInput): BatchExecutionAllocation;
```

按 residual 同文件、普通 task 同目录形成 group key，再按 group key/taskKey 排序；在组内贪心装箱。task 仍指向原 `BehaviorExecutionTask`，不修改 manifest。空白检测复用提取层导出的纯函数；若该函数尚私有，只做最小导出，不改变判定。

- [ ] **Step 4: Implement building/ready publication and immutable loading**

`publishBehaviorBatchPlanSet` 分批插入 plans，并在 plan set 记录 fallback assignments；最后短事务校验每个 manifest task 恰好路由一次并 ready。`loadReadyBehaviorBatchAllocation` 同时恢复 batch/fallback 路由并重算 fingerprint，版本、原因、成员或数量不符抛 `execution_batch_version_conflict`，不得在恢复时重新规划。

- [ ] **Step 5: Verify and commit**

Run targeted tests，预期 PASS；再运行 `tests/behavior-inventory-planner.test.ts tests/behavior-unit-extraction.test.ts` 确认原 planner/空白语义不回归。Run global gate，然后：

```bash
git add lib/execution-batch/planner.ts lib/execution-batch/plans.ts tests/execution-batch-planner.test.ts tests/execution-batch-plans.test.ts lib/behavior-unit-extraction.ts
git commit -m "feat: add deterministic execution batch planner"
```

---

### Task 4: 实际请求身份、详细 completion、receipt 幂等与响应完整性

**Files:**
- Create: `lib/execution-batch/requests.ts`
- Create: `tests/execution-batch-requests.test.ts`
- Modify: `lib/ai.ts:490-618`
- Modify: `lib/billing/cost-receipt.ts`
- Modify: `lib/behavior-run-budget.ts`
- Modify: `tests/ai-gateway.test.ts`
- Modify: `tests/behavior-run-budget.test.ts`

**Interfaces:**
- Produces: `requestStructuredCompletionDetailed(messages, billing): Promise<StructuredCompletionDetails>`；现有 `requestStructuredCompletion` 保持原返回/length 行为。
- Produces: `beginBatchRequest`、`markBatchRequestDispatchStarted`、`persistBatchResponse`、`markBatchRequestOutcome`、`reconcileBatchRequestReceipt`。
- Request 生命周期固定为 `prepared → dispatch_started → response_received → response_persisted`；旁路为 `confirmed_not_sent / failed / outcome_unknown / persistence_failed`。
- `LlmBillingContext` 增加可选 `requestKey/requestFingerprint`；batch 必传，legacy 可空。
- `BudgetReservationInput` 增加可选 `kind`，默认 `task`；新增 `batch` 与 `task_repair`，孤儿对账覆盖三种非摘要类型。
- `StructuredCompletionDetails = { content, usageRaw, providerRequestId, finishReason }`。

- [ ] **Step 1: Write failing request/receipt/response tests**

覆盖：
- `prepared request does not prove dispatch and missing response does not prove not sent`。
- `dispatch started without response becomes outcome unknown rather than confirmed not sent`。
- `received response cannot be parsed before persistence and readback verification`。
- `deduplicates only the same actual request receipt`。
- `does not deduplicate different stages or sequences`。
- `allows monotonic unknown to known usage reconciliation but rejects overwrite`。
- `persists exact response bytes and verifies readback hash`。
- `rejects oversized truncated or mismatched stored responses`。
- `preserves legacy content return and length exception behavior`。
- `settles a batch reservation from all actual request receipts including unknown`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-requests.test.ts tests/ai-gateway.test.ts tests/behavior-run-budget.test.ts`
Expected: 新用例 FAIL，现有用例不得被删除或放宽。

- [ ] **Step 3: Implement detailed completion without changing legacy callers**

抽取共享 gateway 调用，详细版返回 content/usage/requestId/finishReason；现有 wrapper 对 length 继续抛 `AiOutputTruncatedError`。receipt 携带 request identity 和实际 `duration_ms`，网络失败/超时仍即时记录，为后续 benchmark 提供新增观测而不回填历史缺失值。

- [ ] **Step 4: Implement request lifecycle and monotonic receipt reconciliation**

签名：

```ts
export function beginBatchRequest(input: BeginBatchRequestInput): Promise<BatchRequest>;
export function markBatchRequestDispatchStarted(input: MarkBatchDispatchInput): Promise<BatchRequest>;
export function persistBatchResponse(input: PersistBatchResponseInput): Promise<BatchRequest>;
export function markBatchRequestOutcome(input: MarkBatchRequestOutcomeInput): Promise<void>;
export function reconcileBatchRequestReceipt(input: ReconcileBatchReceiptInput): Promise<void>;
```

先 insert `prepared` request，进入 gateway fetch 前条件更新为 `dispatch_started`；收到完整响应先记 `response_received`，读回字节数/hash 一致才 `response_persisted`。仅本地尚未 dispatch 或供应商明确未接收时可 `confirmed_not_sent`。每个新实际请求使用新 request key/sequence；相同 request+fingerprint 重复 receipt no-op，只有 provider id/usage 的 unknown→known 单调补全允许更新。

- [ ] **Step 5: Verify and commit**

Targeted tests PASS，尤其 `tests/behavior-run-budget.test.ts` 的既有 usage unknown 门禁不变。Run global gate，然后：

```bash
git add lib/execution-batch/requests.ts lib/ai.ts lib/billing/cost-receipt.ts lib/behavior-run-budget.ts tests/execution-batch-requests.test.ts tests/ai-gateway.test.ts tests/behavior-run-budget.test.ts
git commit -m "feat: add execution batch request and receipt lifecycle"
```

---

### Task 5: 双步 batch prompt、schema 与无损 payload 映射

**Files:**
- Create: `lib/execution-batch/protocol.ts`
- Create: `tests/execution-batch-protocol.test.ts`

**Interfaces:**
- Consumes: Task 2 members/R aliases、Task 4 completion details。
- Produces: `buildBatchDescribePrompt`、`buildBatchJudgePrompt`、`parseBatchDescribeContent`、`parseBatchJudgeContent`。
- Parse output 按 taskKey 返回独立 payload/failure；整体 JSON 语法错误抛 `BatchProtocolError`。

- [ ] **Step 1: Write failing protocol tests**

覆盖：
- `round trips each task payload through existing single task parsers`。
- `uses persisted T and R aliases rather than array position identity`。
- `rejects duplicate task or region aliases only for the affected task`。
- `keeps cross task evidence and scenario references isolated`。
- `missing task and missing region remain unresolved inputs not no_behavior`。
- `judge prompt binds describe response hash and identical member mapping`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-protocol.test.ts`
Expected: FAIL，protocol 不存在。

- [ ] **Step 3: Implement prompt builders and two-level parsing**

签名：

```ts
export function buildBatchDescribePrompt(input: BatchDescribeInput): BatchChatMessage[];
export function buildBatchJudgePrompt(input: BatchJudgeInput): BatchChatMessage[];
export function parseBatchDescribeContent(content: string, members: BatchAttemptMember[]): BatchTaskParseResult<BehaviorRegionDescription[]>[];
export function parseBatchJudgeContent(content: string, members: BatchAttemptMember[]): BatchTaskParseResult<BehaviorJudgeOutput>[];
```

外层只解析语法和 T 包装；各 T payload 通过 `JSON.stringify` 交给现有 `parseDescribeContent/parseJudgeContent`。不得复制 feature/scenario Zod schema。

- [ ] **Step 4: Verify and commit**

Run targeted tests + `tests/behavior-unit-extraction.test.ts`，Expected: PASS。Run global gate，然后：

```bash
git add lib/execution-batch/protocol.ts tests/execution-batch-protocol.test.ts
git commit -m "feat: add dual stage execution batch protocol"
```

---

### Task 6: Attempt 单向状态机、member 原子 claim 与 processing fencing

**Files:**
- Create: `lib/execution-batch/attempts.ts`
- Create: `tests/execution-batch-attempts.test.ts`
- Modify: `lib/behavior-unit-receipts.ts`

**Interfaces:**
- Produces: `createBatchAttempt`、`claimBatchAttemptMember`、`freezeBatchAttemptMembers`、`acquireBatchAttemptProcessing`、`transitionBatchAttempt`、`loadBatchAttemptForRecovery`。
- Task claim + member insert 使用 Task 2 `withBatchTransaction`。
- `loadBatchAttemptForRecovery` 返回原 member/request identity 和当前 task 提交资格，不改写 request member。

- [ ] **Step 1: Write failing state and race tests**

覆盖：
- `claim and member insert commit or roll back together`。
- `claiming recovery may continue claiming before members are frozen`。
- `members and R aliases freeze before describe and reject later additions`。
- `zero members cannot freeze and follow aborted release path`。
- `member change or model retry requires a new attempt`。
- `only current processing owner and version can transition or split`。
- `expired task lease requires new task claim before submission`。
- `old task attempt cannot commit with a new lease owner`。
- `unknown terminal request preserves exact stage and sequence`。
- `splitting recovery repeats derivation without new model request`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-attempts.test.ts tests/behavior-task-leases.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: Implement attempt persistence and legal transitions**

签名：

```ts
export function createBatchAttempt(input: CreateBatchAttemptInput): Promise<BatchAttempt>;
export function claimBatchAttemptMember(input: ClaimBatchMemberInput): Promise<ClaimedBehaviorTask | null>;
export function freezeBatchAttemptMembers(input: FreezeBatchMembersInput): Promise<BatchAttempt>;
export function acquireBatchAttemptProcessing(input: AcquireBatchProcessingInput): Promise<BatchProcessingGrant>;
export function transitionBatchAttempt(input: TransitionBatchAttemptInput): Promise<BatchAttempt>;
export function loadBatchAttemptForRecovery(input: LoadBatchAttemptRecoveryInput): Promise<BatchRecoveryContext>;
```

异常状态为终态；只有 `splitting` 可在新 processing grant 下继续确定性工作。`claiming` 是特殊可恢复状态：崩溃后只要 `members_frozen_at` 为空，可继续 claim 剩余候选或冻结当前非空子集；冻结是进入 describe 的独立原子步骤，之后成员/T/R 不再变化。模型重试由 coordinator 创建新 attempt，不提供原 attempt 回退 API。

- [ ] **Step 4: Verify and commit**

Targeted tests 与现有 lease 测试 PASS。Run global gate，然后：

```bash
git add lib/execution-batch/attempts.ts lib/behavior-unit-receipts.ts tests/execution-batch-attempts.test.ts tests/behavior-task-leases.test.ts
git commit -m "feat: add execution batch attempt recovery state machine"
```

---

### Task 7: 按 task 拆分、证据清洗、截断处理与独立结果推导

**Files:**
- Create: `lib/execution-batch/extraction.ts`
- Create: `tests/execution-batch-extraction.test.ts`
- Modify: `lib/behavior-unit-extraction.ts:185-240`

**Interfaces:**
- Consumes: Task 5 protocol、Task 6 recovery context。
- Produces: `extractBehaviorBatch(input: ExtractBatchInput): BatchTaskExtractionResult[]`。
- 从现有模块导出 `deriveBehaviorTaskResult` 和 `behaviorTaskTruncatedResult`，原 `extractBehaviorTask` 行为不变。

- [ ] **Step 1: Write failing extraction tests**

覆盖：
- `five valid tasks commit eligible results while one missing region stays unresolved`。
- `task evidence allow set does not include sibling task files`。
- `describe length skips judge and marks every member output_truncated`。
- `judge length accepts no partial task success`。
- `complete json with missing task is not treated as complete batch coverage`。
- `same raw response and parser version derives the same result fingerprint`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-extraction.test.ts tests/behavior-unit-extraction.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: Export single-task derivation and implement batch orchestration pure functions**

签名：

```ts
export function extractBehaviorBatch(input: ExtractBatchInput): BatchTaskExtractionResult[];
```

输入为原始 responses、members、tasks 和 sourcesByTask；输出只含各 task 的确定性结果，不直接写 DB。截断按 spec 保守处理，未知/缺失输出不转换为 no_behavior。

- [ ] **Step 4: Verify and commit**

Targeted tests PASS。Run global gate，然后：

```bash
git add lib/execution-batch/extraction.ts lib/behavior-unit-extraction.ts tests/execution-batch-extraction.test.ts
git commit -m "feat: derive independent task results from batch responses"
```

---

### Task 8: 主编排、独立提交、单 task repair 与默认关闭的 feature flag

**Files:**
- Create: `lib/execution-batch/runner.ts`
- Create: `tests/execution-batch-runner.test.ts`
- Modify: `lib/full-analysis.ts`
- Modify: `lib/env.ts:87-117`
- Modify: `tests/full-analysis.test.ts`

**Interfaces:**
- Produces: `behaviorAnalysisExecutionMode(): "task" | "batch"`，默认/垃圾值为 task。
- Produces: `runInventoryBatchAttempt(input: RunBatchAttemptInput): Promise<void>`、`recoverInventoryBatchAttempts(input: RecoverBatchAttemptsInput): Promise<void>`。
- `RunBatchAttemptInput` 支持 `extractionMode?: "describe_judge"`，为 Task 13 保留扩展，不在本 Task 实现 fused。
- Repair 身份显式分为 `task_attempt_id`（原 task 租约/提交）、`repair_budget_attempt_id`（reservation 聚合）和 `repair_request_key`（实际模型请求/receipt）。

- [ ] **Step 1: Write failing runner and integration tests**

覆盖：
- `default and invalid execution mode preserve existing single task dispatch`。
- `partial claims only request claimed members with original aliases`。
- `successful tasks commit independently with current task attempts`。
- `reservation settlement does not depend on all tasks being committed`。
- `unresolved members use single task repair with separate one call reservation`。
- `repair keeps task attempt while using distinct repair budget attempt and request key`。
- `repair crash may repeat only the repair call under existing semantics and never repeats persisted main batch responses`。
- `persisted describe resumes with judge only and persisted judge resumes with zero calls`。
- `batch mode never changes final aggregation or activation calls`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-runner.test.ts tests/full-analysis.test.ts`
Expected: 新用例 FAIL，旧 task/legacy/inventory 路径保持基线。

- [ ] **Step 3: Implement runner and integrate a separate work queue**

`runInventoryBatchAttempt` 串联 Tasks 3–7；`full-analysis` 按恢复后的完整 allocation 将 work item 分为 fallback single task 与 batch plan，不重算路由。恢复先处理 persisted responses，再创建新 attempts。成功 task 用现有 `commitBehaviorTaskResult`；repair 保持原 `task_attempt_id` 租约/提交身份，使用独立一次 judge 的 `kind=task_repair` reservation、`repair_budget_attempt_id` 和独立 `repair_request_key`，batch 的 `kind=batch` reservation 先结算。激活仍等待所有已发起 repair。

本 Task 不新增 repair 原始响应存储。若 repair 已调用但响应未提交，现有单 task 恢复可能需要重发 repair；测试必须验证真实 receipt/unknown usage 和不重复主 batch，而不得宣称 repair 零调用恢复。

- [ ] **Step 4: Verify full regression and commit**

Run: `npm run test:direct -- tests/execution-batch-runner.test.ts tests/full-analysis.test.ts tests/behavior-activation.test.ts`
Expected: PASS。Run global gate，然后：

```bash
git add lib/execution-batch/runner.ts lib/full-analysis.ts lib/env.ts tests/execution-batch-runner.test.ts tests/full-analysis.test.ts
git commit -m "feat: integrate execution batch into inventory analysis"
```

---

### Task 9: Batch 可观测性与现有 RunStatus 进度展示

**Files:**
- Create: `lib/execution-batch/progress.ts`
- Create: `tests/execution-batch-progress.test.ts`
- Modify: `lib/product-details.ts`
- Modify: `lib/product-overview.ts:23-24`
- Modify: `components/product-navigation.tsx:34-43`
- Modify: `lib/ui-strings/product.ts:23-26`
- Modify: `tests/product-details.test.ts`
- Modify: `tests/product-navigation.test.ts`

**Interfaces:**
- Produces: `loadExecutionBatchProgress(execute, runId): Promise<ExecutionBatchProgress | null>`；无 manifest 时返回 null，不伪造扫描完成。
- `ExecutionBatchProgress` 包含 scannedFiles、units、tasksTotal、successfulTasks、unresolvedTasks、activeBatches、activationStatus、usedTokens、costAmount、usageUnknown。
- `RunStatus` 接受可选 `progress`；只展示事实计数，不展示“可靠理解百分比”或数据不足时的 ETA。

本 Task 移出核心正确性依赖链，在 Task 11 证明双步 batch 有实际收益后实施；不得阻塞 Task 10 故障注入或 Task 11/12 性能实验。启动前需对 product-details/product-navigation 的真实修改重新做行为影响反查。

- [ ] **Step 1: Write failing progress and rendering tests**

覆盖：
- `distinguishes scanning task execution proof completion and activation`。
- `counts unresolved separately from extracted and no_behavior`。
- `shows active batch count and unknown usage without zero cost claims`。
- `does not show batch progress for legacy runs or before a manifest exists`。
- `marks non activated intermediate results explicitly and does not show ETA without samples`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-progress.test.ts tests/product-details.test.ts tests/product-navigation.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: Implement read-only progress projection and server loading**

从 manifest diagnostics、task rows、batch attempts 和 run budget/receipts 计算进度；`product-details` 查询 latest run id 并加载对应 projection。不得在页面 render 时重新推导行为事实。

- [ ] **Step 4: Render progress without changing activation semantics**

扩展现有 `RunStatus` 与 `RUN_STATUS` 中英文字符串。保留原状态、错误解释和 3 秒刷新；未激活中间结果仅标为处理中/未激活，未完成 activation 不展示为可靠规格。

- [ ] **Step 5: Verify and commit**

Targeted tests PASS。Run global gate，然后：

```bash
git add lib/execution-batch/progress.ts lib/product-details.ts lib/product-overview.ts components/product-navigation.tsx lib/ui-strings/product.ts tests/execution-batch-progress.test.ts tests/product-details.test.ts tests/product-navigation.test.ts
git commit -m "feat: expose execution batch analysis progress"
```

---

### Task 10: 故障注入与恢复验收门禁

**Files:**
- Create: `tests/execution-batch-recovery.test.ts`
- Create: `tests/execution-batch/helpers.ts`
- Modify only failures revealed by tests: `lib/execution-batch/*.ts`

**Interfaces:**
- Consumes: Tasks 2–8 全部公共接口；Task 9 UX 不是本故障门禁的依赖。
- Produces: 可重复运行的 recovery 集成测试，不生成临时报告或数据库容器。

- [ ] **Step 1: Build shared in-memory batch store and write the complete failure matrix**

必须包含：
- 两个 worker 同时恢复、splitting 竞争、旧 processing owner 迟到提交。
- task lease 过期重新 claim、旧 task attempt 被拒绝、部分续租失败。
- 原始响应存在但 task 已由其他合法 attempt 完成。
- receipt 重复投递、provider id 缺失、unknown→known、unknown 不可解。
- plan/T/R/parser 不匹配、响应读回 hash 错误、response 容量超限。
- 主 batch 成功且 reservation settled 后 repair 崩溃，恢复不重复 describe/judge、不提前激活。
- task claim 与 member 写入任一失败，均无半持久化 member。

- [ ] **Step 2: Run matrix and classify every failure before fixing**

Run: `npm run test:direct -- tests/execution-batch-recovery.test.ts`
Expected: 新测试能运行；任何 FAIL 先归类为测试夹具错误或产品契约缺陷，不删除断言。

- [ ] **Step 3: Fix only demonstrated contract defects**

每处修复先保留对应失败测试。不得通过扩大 allowSet、忽略 stale attempt、将 unknown 当零或跳过 activation 来变绿。

- [ ] **Step 4: Repeat recovery matrix and all behavior regression tests**

Run: `npm run test:direct -- tests/execution-batch-recovery.test.ts tests/execution-batch-runner.test.ts tests/full-analysis.test.ts tests/behavior-task-leases.test.ts tests/behavior-run-budget.test.ts`
Expected: PASS。此步骤未通过不得进入真实 benchmark。

- [ ] **Step 5: Run global gate and commit**

```bash
git add tests/execution-batch-recovery.test.ts tests/execution-batch/helpers.ts lib/execution-batch
git commit -m "test: prove execution batch recovery and accounting"
```

---

### Task 11: 双步 batch 质量与性能对照

**Files:**
- Create: `scripts/execution-batch-benchmark.ts`
- Create: `scripts/execution-batch-export.ts`
- Create: `tests/execution-batch-benchmark.test.ts`
- Create on real results only: `docs/benchmark/execution-batch-results.md`
- Create on real results only: `artifacts/execution-batch/batch-comparison.json`

**Interfaces:**
- Consumes: Task 1 冻结协议、Task 8 runner、Task 10 recovery gate、现有 `evaluateBehaviorNonInferiority`。
- CLI: `npx tsx scripts/execution-batch-benchmark.ts --commit <sha> --concurrency 4 --mode task|batch`；脚本固定 `FULL_ANALYSIS_MODE=inventory`，并将 `--mode` 映射到 `ANALYSIS_BEHAVIOR_EXECUTION_MODE`。
- Export 使用项目 `databaseConfig/defaultExecute`，不得复制现有脚本中硬编码主机或凭证文件读取方式。

- [ ] **Step 1: Write failing benchmark accounting tests**

覆盖：
- `uses actual batchable describe and judge calls as request reduction denominator`。
- `reports request token cost and wall time independently`。
- `fails process gates before accepting statistical non inferiority`。
- `marks missing blind accounting inconclusive rather than passed`。

- [ ] **Step 2: Run tests, implement harness, verify**

Run: `npm run test:direct -- tests/execution-batch-benchmark.test.ts`
Expected: 先 FAIL 后 PASS。实现只组装运行参数和导出真实记录，不实现第二套非劣统计。

- [ ] **Step 3: Run paired scratch benchmark after explicit spend approval**

同一 commit/manifest/模型分别运行 task 与 batch，并发均为 4。导出盲评包，评审者不知道路径来源；比较召回、假阳性、证据支持、reviewed_internal 误判、unresolved、截断和过程门禁。

- [ ] **Step 4: Publish only measured results**

`batch-comparison.json` 保存真实 calls/tokens/cost/wall time、run IDs 和配置指纹；报告列出基线缺失项。目标：可组批请求下降 ≥60%、墙钟目标下降 ≥30%、单位有效完成成本不恶化；20 分钟仅为挑战目标。

- [ ] **Step 5: Run global gate and commit harness plus measured report**

```bash
git add scripts/execution-batch-benchmark.ts scripts/execution-batch-export.ts tests/execution-batch-benchmark.test.ts docs/benchmark/execution-batch-results.md artifacts/execution-batch/batch-comparison.json
git commit -m "bench: compare dual stage execution batch"
```

---

### Task 12: 固定并发档位 benchmark 与默认配置建议

**Files:**
- Modify: `scripts/execution-batch-benchmark.ts`
- Modify: `tests/execution-batch-benchmark.test.ts`
- Create on real results only: `docs/benchmark/execution-batch-concurrency.md`
- Create on real results only: `artifacts/execution-batch/concurrency-comparison.json`

**Interfaces:**
- CLI 增加 `--repetitions 2`；4/8/12/16 使用相同 batch planner/version、commit 和模型配置，并按 `4,8,12,16,16,12,8,4` 交错顺序运行，降低时间段与缓存偏向。
- 不实现自适应并发，不自动把最优档写入生产 env。

- [ ] **Step 1: Add failing repetition and variance tests**

`requires a third run when total wall time relative difference exceeds twenty percent`：两次总时长按 `|x1-x2| / ((x1+x2)/2) > 0.20` 计算时追加第三次；不得把两个观测称为 P95 或统计方差，不选择性删除离群值。

- [ ] **Step 2: Implement repetition reporting and verify unit tests**

输出每档全部 run、平均/区间、吞吐、429、timeout、在途 token、worker 空闲、DB 等待和实际费用；P95 请求延迟基于该档全部实际请求样本计算，不用两次 run 的 P95 差异充当稳定性指标。

- [ ] **Step 3: Run scratch concurrency matrix after separate spend approval**

每档至少 2 次；总时长相对差异 >20% 加第 3 次。保留全部 run，若 8 已到平台期，不为追求 16 增加成本。

- [ ] **Step 4: Record recommendation and commit**

只有质量/恢复门禁持续通过时才推荐默认档位；否则保持 4 并说明瓶颈。Run global gate，然后：

```bash
git add scripts/execution-batch-benchmark.ts tests/execution-batch-benchmark.test.ts docs/benchmark/execution-batch-concurrency.md artifacts/execution-batch/concurrency-comparison.json
git commit -m "bench: measure execution batch concurrency"
```

---

### Task 13: 默认关闭的 describe + judge 融合实验

**Files:**
- Create: `lib/execution-batch/fused-protocol.ts`
- Create: `tests/execution-batch-fused-protocol.test.ts`
- Modify: `lib/execution-batch/types.ts`
- Modify: `lib/execution-batch/runner.ts`
- Modify: `lib/env.ts`
- Modify: `tests/execution-batch-runner.test.ts`
- Create on real results only: `docs/benchmark/execution-batch-fused.md`

**Interfaces:**
- Produces: `behaviorBatchExtractionMode(): "describe_judge" | "fused"`，默认/垃圾值为 describe_judge。
- Produces: `buildBatchFusedPrompt`、`parseBatchFusedContent`；fused region 同时包含 facts/inputs/controlFlow/externalEffects 与现有 judge 字段。
- fused 每 attempt 一次请求、reservation `maxLlmCalls=1`；planner 和成员与双步实验完全一致。

- [ ] **Step 1: Write failing fused schema and runner tests**

覆盖：
- `default mode remains dual stage`。
- `fused region preserves facts and judgment fields without weakening validation`。
- `missing facts evidence or surviving scenario attribution remains unresolved`。
- `fused truncation never becomes no_behavior`。
- `fused attempt uses one request and its own reservation`。
- `dual and fused runs receive identical planned members and T/R mappings`。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:direct -- tests/execution-batch-fused-protocol.test.ts tests/execution-batch-runner.test.ts`
Expected: 新用例 FAIL。

- [ ] **Step 3: Implement fused adapter only behind explicit flag**

复用现有单 task 终态推导；不把两个 prompt 简单拼接，不删除事实字段，不改变 batch plan、task 提交或 activation。fused 不进入默认生产路径。

- [ ] **Step 4: Verify and run independent paired experiment**

Targeted tests PASS 后，使用 Task 11 的相同 batch plans 做双步/融合盲评；共享副作用、reviewed_internal、证据支持和 unresolved 单独报告。质量或成本无收益则保留双步，不强行上线。

- [ ] **Step 5: Run global gate and commit**

```bash
git add lib/execution-batch/fused-protocol.ts lib/execution-batch/types.ts lib/execution-batch/runner.ts lib/env.ts tests/execution-batch-fused-protocol.test.ts tests/execution-batch-runner.test.ts docs/benchmark/execution-batch-fused.md
git commit -m "feat: add optional fused batch extraction experiment"
```

---

## Final Verification and Delivery Gate

- [ ] `npm run typecheck` PASS。
- [ ] `npm test` PASS。
- [ ] `npm run build` PASS。
- [ ] 默认 task 模式的现有 full-analysis 回归全部 PASS。
- [ ] Recovery matrix、receipt 对账和 T/R/schema 兼容测试全部 PASS。
- [ ] 真实 benchmark 报告只包含实际测量值，所有 unknown 均有原因。
- [ ] `git status` 无测试生成的临时日志、数据库转储、凭证或报告临时文件。
- [ ] push 后按 Behavior Ledger Anchors 对账；计划外行为变化回查。
- [ ] 未获单独批准不启用生产 batch/fused，不执行生产部署。
