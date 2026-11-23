# CoDelphi 分析管线批处理改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 inventory 证明模型、task 独立结果和激活门禁的前提下，以 execution-batch 降低模型调用、token 与实际成本，同时不增加碎片化或降低行为与证据质量。

**Architecture:** 复用已接入 `full-analysis` 的双步 execution-batch。I0 保留已完成的 inventory task 基线，I1 在独立 scratch 库启用 batch；本轮不增加静态事实层、不启用 fused、不改变生产默认 task 模式。

**Tech Stack:** TypeScript、Next.js 16、MySQL 8、Zod 4、Vitest 4、现有 execution-batch、LLM receipts 与配对 Benchmark。

**Spec:** `docs/superpowers/specs/2026-11-23-analysis-pipeline-batch-improvement-design.md`

## Global Constraints

- 不改变 unit / anchor / fragment / task 身份、覆盖证明、证据 allowSet、确定性聚合或 activation gate。
- 不开发静态事实层，不启用 fused，不做生产部署；默认 `ANALYSIS_BEHAVIOR_EXECUTION_MODE=task`。
- I0 不得重跑替换；I1 使用独立 scratch 规格与运行状态，不复用 I0 的规格或 AI 输出。
- 人工规格与人工裁决不得被覆盖；unresolved/failed 不得伪装成 no_behavior。
- 不得通过减少实现面、跳过未识别代码或扩大 residual 区间换取成本下降。
- plan、attempt、原始响应和 task 提交不得互相冒充真源；usage/provider 未知不得按零成本处理。
- 只有实际发现的 batch 缺陷才进入修复，且必须先写失败测试；不预先扩大实现范围。
- 每个任务运行聚焦测试；收尾运行 `npm run typecheck`、`npm test`、`npm run build` 并检查 `git status`，不删除用户已有未跟踪文件。

## Review Focus

- attempt/member/task 状态不一致：只能以对应真源推进，不得提前激活；由 Task 2 的故障注入与恢复测试固定。
- 重复恢复或旧 lease 竞争：成功任务零新增调用，过期 attempt 不得覆盖新结果；由 Task 2 测试固定。
- 输出碎片化或事实解释漂移：功能/场景/重复簇和严格运算符不得越过门禁；由 Task 3 盲评固定。
- 成本回执缺失、定价或缓存不可比：判 inconclusive，不得以平均值掩盖失败仓；由 Task 1 和 Task 3 固定。
- 激活失败：只保留实验结果，不切换生产模式；由 Task 3 验收固定。

## 验收门禁

- 准确性：召回不下降；误报率上升 ≤3pp；证据有效率下降 ≤2pp；严格运算符解释错误不增加。
- 碎片化：功能数 ≤ I0×1.05；场景数 ≤ I0×1.10；重复功能簇不增加。
- 成本：LLM 总调用 ≤ I0×0.35；总 token ≤ I0×0.60；同定价实际成本 ≤ I0×0.60。
- 每个匹配 task 的 total/describe/judge/semantic_repair 不增加；成功恢复零新增调用。
- 激活失败不授权采用；failed 优先于 inconclusive，缺证据或不可比输入不得放行。

## 行为反查与对账锚点

已通过 `lookup_by_files` 反查 execution-batch 与测量文件；原始结果保存在本计划 workspace。

重点 stableKeys：执行批处理编排与恢复、执行批处理协议与请求持久化、执行批处理编排与协议、执行批处理规划与发布、执行批处理计划发布与恢复、执行批处理 attempt 与成员冻结、执行批处理 attempt 状态机、执行批请求持久化、执行批处理提取与 fused 协议、执行批处理结果拆分与基准裁决、行为清单全量分析编排。

回归红线：人工保护、证据 allowSet、覆盖/激活门禁、请求与响应幂等、预算结算、恢复零新增调用、无计划外行为 Delta。每次 push 后用 `list_releases` 找 SHA，再以 `get_release` 和 `reconcile_release` 核对。

---

### Task 1: 批处理验收规则与离线门禁收口

**Files:**
- Modify: `lib/pipeline-improvement-benchmark.ts`
- Modify: `lib/pipeline-usage.ts`
- Modify: `scripts/measure-pipeline-improvement.ts`
- Modify: `scripts/export-pipeline-usage.ts`
- Modify: `tests/pipeline-improvement-benchmark.test.ts`
- Modify: `tests/pipeline-usage.test.ts`
- Modify: `docs/benchmark/frozen/analysis-pipeline-improvement-v1.md`
- Modify: `docs/benchmark/frozen/analysis-pipeline-experiment-v1.schema.json`

**Interfaces:**
- Consumes: 已冻结的 L/I0 comparison、usage、实验身份和 `evaluateBehaviorNonInferiority()`。
- Produces:
  - `PipelineOutputFacts = { featureCount: number; scenarioCount: number; duplicateClusters: number; factInterpretationErrors: number; activationPassed: boolean }`
  - `ImprovementRepoInput` 增加 `baselineOutput / candidateOutput`，删除 `targetBehaviorIds` 的修复漏报要求。
  - `PipelineImprovementVerdict` 增加 `adoptionReady: boolean`。
- 成本常量：`MAX_LLM_CALL_RATIO=0.35`、`MAX_TOKEN_RATIO=0.60`、`MAX_COST_RATIO=0.60`；碎片化常量：`MAX_FEATURE_RATIO=1.05`、`MAX_SCENARIO_RATIO=1.10`。

- [ ] **Step 1: 先修改测试并观察失败**

将“必须修复漏报”的用例改为：召回不下降即可；加入功能数 1.05、场景数 1.10、重复簇和事实解释错误不增加、调用/token/成本比例精确边界、adoptionReady 激活要求。保留 task/stage 调用、恢复、实验身份和 failed/inconclusive 优先级测试。

- [ ] **Step 2: 运行测试确认失败原因**

Run: `npx vitest run tests/pipeline-improvement-benchmark.test.ts tests/pipeline-usage.test.ts`
Expected: FAIL，缺少输出事实字段及新比例门禁。

- [ ] **Step 3: 实现纯函数规则**

保留现有统计复用与全部身份校验。逐仓比较输出事实、成本和 task usage；候选激活失败时 `adoptionReady=false`，实验判定与是否授权采用分开表达。缺字段或不可比输入为 inconclusive，确定越界为 failed。

- [ ] **Step 4: 更新 descriptor 与离线解析**

在 schema 中增加 baseline/candidate output 引用和 required 字段；CLI 读取输出事实 JSON。保留 v1 comparison 的 legacy/inventory 路径映射，不改变既有 `behavior-inventory-v1` 统计口径。

- [ ] **Step 5: 运行聚焦测试与合成实验**

Run: `npx vitest run tests/pipeline-improvement-benchmark.test.ts tests/pipeline-usage.test.ts tests/behavior-benchmark.test.ts`
Expected: PASS。再用合成 experiment 运行 `npx tsx scripts/measure-pipeline-improvement.ts --experiment <fixture> --out <report>`，检查比例和 adoptionReady。

- [ ] **Step 6: 运行标准验证并提交**

```bash
npm run typecheck
npm test
npm run build
git add lib/pipeline-improvement-benchmark.ts lib/pipeline-usage.ts scripts/measure-pipeline-improvement.ts scripts/export-pipeline-usage.ts tests/pipeline-improvement-benchmark.test.ts tests/pipeline-usage.test.ts docs/benchmark/frozen/analysis-pipeline-improvement-v1.md docs/benchmark/frozen/analysis-pipeline-experiment-v1.schema.json
git commit -m "test: add batch quality fragmentation and cost gates"
```

### Task 2: 运行 batch I1 并修复实测缺陷

**Files:**
- Modify only as needed: `lib/execution-batch/runner.ts`
- Modify only as needed: `lib/execution-batch/planner.ts`
- Modify only as needed: `lib/execution-batch/attempts.ts`
- Modify only as needed: `lib/execution-batch/requests.ts`
- Modify only as needed: `lib/execution-batch/extraction.ts`
- Modify only as needed: `lib/full-analysis.ts`
- Modify: `scripts/bench-run-once.ts`（仅增加显式 scratch 配置）
- Test: `tests/bench-run-once.test.ts`
- Test: `tests/execution-batch-*.test.ts`、`tests/full-analysis.test.ts`

**Interfaces:**
- Consumes: Task 1 的门禁、I0 已冻结 manifest/task 结果、`behaviorAnalysisExecutionMode()` 和现有 batch runner。
- Produces: 同一目标 revision 的 I1 runId、plan/attempt/response/task 结果、完整回执和可导出的合并规格。

- [ ] **Step 1: 先为 scratch 配置写失败测试**

在 `tests/bench-run-once.test.ts` 验证：`BENCH_AFTER_SHA` 覆盖默认 revision、`BENCH_DATABASE=codelphi_bench_i1` 被采用，非 scratch 数据库在创建 run 前拒绝。先运行 `npx vitest run tests/bench-run-once.test.ts` 确认 RED，再最小修改 `scripts/bench-run-once.ts`，复用 `assertBenchmarkDatabaseName()` 并保持原默认参数兼容。

- [ ] **Step 2: 在独立 scratch 库启动 I1**

```bash
DOTENV_CONFIG_PATH=/Users/leihan/Documents/GitHub/codelphi/.env \
BENCH_DATABASE=codelphi_bench_i1 \
BENCH_AFTER_SHA=2659429e588da466fcb712ba096531343aa75d08 \
FULL_ANALYSIS_MODE=inventory \
ANALYSIS_BEHAVIOR_EXECUTION_MODE=batch \
ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE=describe_judge \
ANALYSIS_BEHAVIOR_CONCURRENCY=16 \
npx tsx scripts/bench-run-once.ts inventory
```

使用 `codelphi_bench_i1` 和相同 afterSha；不得复用 I0 的规格、task 结果或 AI 输出。记录 runId 和配置。

- [ ] **Step 2: 先处理运行故障**

若出现 plan、member、协议、恢复或激活缺陷，先写一个能复现该具体故障的测试并确认 RED，再做最小修复。不得因任务量大直接改 planner 或减少实现面。

- [ ] **Step 3: 运行受影响测试并验证修复**

Run: `npx vitest run tests/execution-batch-*.test.ts tests/full-analysis.test.ts`
Expected: 新回归先 RED 后 GREEN，既有测试保持通过。

- [ ] **Step 4: 恢复剩余任务并验证零重复**

恢复只使用同一 run 的持久化结果。核对成功任务没有新调用，过期 attempt 不覆盖新结果，plan/member/task 状态一致。若恢复中开启新 run，记录原因，不得替换不利输出。

- [ ] **Step 5: 运行标准验证并提交实际修复**

```bash
npm run typecheck
npm test
npm run build
git add lib/execution-batch lib/full-analysis.ts scripts/bench-run-once.ts tests/execution-batch-*.test.ts tests/full-analysis.test.ts tests/bench-run-once.test.ts
git commit -m "fix: harden batch execution from shadow findings"
```

若无代码缺陷，不提交空变更；只在 ledger 记录“I1 运行未需实现修改”。

### Task 3: 导出 I1、盲评与采用建议

**Files:**
- Modify: `docs/analysis-pipeline.md`
- Modify: `docs/benchmark/frozen/analysis-pipeline-improvement-v1.md`（只记录实际结果，不改阈值）
- Create locally: `artifacts/behavior-pipeline-improvement/report.json`

**Interfaces:**
- Consumes: L/I0 冻结输出、I1 结果、Task 1 离线门禁。
- Produces: 质量、碎片化、成本、激活状态和 adoptionReady 报告。

- [ ] **Step 1: 导出 I1 合并结果与 usage**

若 I1 激活失败，以 `activate=false` 导出合并结果，不通过额外重试美化输出。导出每 task/stage 回执、成本、耗时和输出事实；保留激活失败原因。

- [ ] **Step 2: 完成匿名盲评**

评审 34 条真值、严格运算符和至少 100 条分层输出样本，分别记录召回、误报、证据支持、事实解释错误、功能/场景数和重复功能簇。AI 评审须披露独立性折扣，最终采用由用户决定。

- [ ] **Step 3: 运行离线与标准验证**

```bash
npx tsx scripts/measure-inventory-analysis.ts --input legacy-vs-i1.json --out legacy-vs-i1-report.json
npx tsx scripts/measure-pipeline-improvement.ts --experiment experiment.json --out artifacts/behavior-pipeline-improvement/report.json
npm run typecheck
npm test
npm run build
```

Expected: 所有确定门禁通过才计算 adoptionReady；failed/inconclusive 均不得建议启用 batch。

- [ ] **Step 4: 更新文档并提交**

记录成本、碎片化、准确性、激活状态和是否需实现修改。若验收未执行或未通过，明确保持 task 默认，不把单元测试通过写成 shadow 通过。

```bash
git add docs/analysis-pipeline.md docs/benchmark/frozen/analysis-pipeline-improvement-v1.md
git commit -m "docs: record batch pipeline shadow evaluation"
```

- [ ] **Step 5: push 后行为对账**

使用 `list_releases(slug="codelphi")` 定位 SHA，`get_release` 核对行为变化只覆盖预期批处理/测量范围，再以 `reconcile_release` 传入实际 paths 与反查 stableKeys。计划外变化必须回查，验收报告不构成生产启用授权。
