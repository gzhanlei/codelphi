# CoDelphi 分析管线质量与成本改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不增加每个行为任务的 LLM 调用次数、且不牺牲现有证据与覆盖门禁的前提下，用确定性 TypeScript 分支/边界事实提高 CoDelphi 行为分析的召回率和准确率，并以严格配对 Benchmark 验证质量与成本。

**Architecture:** 保留生产 `legacy` 与基线快照上的未增强 `inventory` 作为对照，只在候选 `inventory` 增加 manifest 内静态事实。单文件 TypeScript AST 负责提取条件及其 true/false 区间、可解析数值比较边界和数值默认值；AI 判定步同时接收事实与原始源码，不增加模型调用，也不把静态事实作为唯一输入。先冻结 L/I0 结果和 I0 漏报，再开发并运行 I1，默认不切换生产模式。

**Tech Stack:** 项目锁定的 TypeScript 5.9.3 编译器 API、Next.js 16、Vitest 4、现有 MySQL 8 manifest JSON、`llm_call_receipts` 与配对 Benchmark；无新第三方包、无数据库 migration。TypeScript 将从 `devDependencies` 移到 `dependencies`，因为生产分析代码会直接导入它。

**Spec:** `docs/analysis-pipeline.md`；`docs/superpowers/specs/2026-11-19-full-analysis-behavior-inventory-design.md`；`docs/benchmark/frozen/behavior-inventory-v1.md`

## Global Constraints

- 仅本地开发与 scratch/shadow 分析；不执行生产部署、DNS、Webhook、Docker 构建推送或生产数据修复。
- `FULL_ANALYSIS_MODE` 默认保持 `legacy`；人工 shadow 验收和用户单独批准前，不启用生产 `inventory`。
- 不引入 USIR、符号执行、SMT、通用抽象解释、完整路径枚举或新第三方包。
- 保留原始源码作为 AI 输入；静态事实缺失、解析失败、文件超限或被预算裁减时，不得阻断既有源码分析。
- 不扩大证据 allowSet；所有 AI 场景仍须引用实际读取的源码，证据位置有效不等于语义解释正确。
- 自动分析不得覆盖 `source = 'manual'` 的功能、场景或人工裁决。
- `unresolved / failed / unreadable / all_candidates_rejected` 不得伪装成 `no_behavior` 或完整成功。
- 保持不可变 manifest、at-least-once + 条件提交、成功任务恢复复用和共享预算会计不变。
- 首轮不改跨版本身份、全局调用图、证据重锚定和增量依赖索引；它们由后续独立计划处理。
- 每个任务运行聚焦测试；收尾运行 `npm run typecheck`、`npm test`、`npm run build`，并检查 `git status`，不删除或提交用户已有未跟踪文件。

## Review Focus

- 非 TypeScript、TSX、语法不完整或超过 AST 预算的文件：事实层明确空缺/失败，原始源码与 residual 审查继续；由 Task 3 测试固定。
- 环境变量、计算表达式、跨文件常量和变量遮蔽：不得猜值或绑定外层同名常量；由 Task 3 测试固定。
- 常量声明或分支区间不在实际 task 源码内：Prompt 投影必须标 `contextIncomplete`，数值断言降级，allowSet 不扩大；由 Task 4 测试固定。
- 静态事实超过 16,000 UTF-8 字节：按类型优先级和稳定顺序裁减，按类型记录 omitted，原始源码不截断；由 Task 4 测试固定。
- v2 manifest 在新代码中恢复：必须 `inventory_version_conflict`，不得混合旧任务与新事实；由 Task 2 测试固定。
- 对照身份、成本、定价或每任务回执不可比：不得因质量提高而自动放行；由 Task 1 和 Task 5 验收固定。
- AI 将 `>` 错写为 `>=`，或静默接受与源码冲突的事实：归类为 fact interpretation error，不由静态层自动改写场景；由 Task 4 和 Task 5 验收固定。

## 验收基线与门禁

### 实验身份与三路径

- `L`：当前生产 `legacy`，只运行一次并冻结 `runId + outputHash`，两份对照复用同一份输出，不重跑。
- `I0`：本计划基线代码快照上的未增强 `inventory`，先于 I1 开发运行并冻结。
- `I1`：候选代码快照上的事实增强 `inventory`，不得复用 I0 的 AI 输出。
- 三路径使用相同目标源码 revision、模型配置、输出语言、预算、定价和缓存条件；scratch 数据库与激活规格相互隔离。
- 每仓建立 `PipelineExperimentIdentity`：

```ts
type PipelineExperimentIdentity = {
  repo: string;
  beforeSha: string | null;
  afterSha: string;
  benchmarkTruthVersion: string;
  model: string;
  modelConfigHash: string;
  outputLanguage: string;
  budgetConfigHash: string;
  pricingConfigHash: string;
  cacheCondition: string;
  legacyResult: { runId: number; outputHash: string };
  baselineCodeSha: string;
  candidateCodeSha: string;
  describePromptHash: { baseline: string; candidate: string };
  judgePromptBaselineHash: { baseline: string; candidate: string };
  repairPromptBaselineHash: { baseline: string; candidate: string };
};
```

- Task 1 冻结目标 revision、truth、模型/预算/定价/缓存、L/I0 结果及 baselineCodeSha；candidateCodeSha 和候选 Prompt hash 在 I1 运行前补齐并冻结，此时仍不得查看 I1 输出。
- describe 模板 hash 必须相同；judge/repair 的“去除静态事实段后的基线模板”hash 必须相同。候选 Prompt 只允许增加同一静态事实段。
- 沿用既有四仓与每仓至少 30 条冻结人工行为；CoDelphi 自仓新增预标至少包含 5 条数值边界和 5 条条件结果，必须在查看 I0/I1 输出前冻结。

### 漏报预登记时序

1. 冻结人工真值和实验身份。
2. 运行并冻结 L、I0；复用同一个 L 结果形成对照。
3. 由不知道路径身份的评审完成盲评，登记 I0 漏报。
4. 在查看任何 I1 输出前，冻结 I0 漏报清单、目标案例和错误分类。
5. 开发并运行 I1；不得事后改选它恰好修复的案例作为目标。
6. 完成 I1 盲评和离线门禁。

目标错误分类固定为：`fact_omission`、`fact_extraction_error`、`fact_interpretation_error`、`behavior_omission`、`evidence_mismatch`。至少一个目标案例必须包含“严格 `>` 不得解释为 `>=`”的检查。

### 质量门禁

- I1 相对 L 必须通过现有 `behavior-inventory-v1`：逐仓 `LowerCI(Delta) > -0.03`、宏平均点估计 `>= -0.03`、误报率上升 `<= 3pp`、证据有效率下降 `<= 2pp`，全部过程门禁通过。
- I1 相对 I0 不得降低任何仓库的冻结行为召回；全测试集至少修复一个预登记 I0 漏报，且不得只增加无证据输出。
- 分支/边界目标案例单独报告，不用大量简单行为稀释目标收益；inconclusive 不视为通过。
- 静态提取错误与 AI 误解正确事实分别报告，不能用最终召回率掩盖二者。

### 成本门禁

- 每仓 I1 总 LLM 调用数不得高于 I0。
- 每个匹配 `taskKey` 的总调用数、describe、judge、semantic_repair 均不得增加；taskKey 集合必须一致。成功恢复任务的新增调用数必须为零。
- 每仓 `I1.totalTokens <= I0.totalTokens * 1.05`。
- 同币种、同定价与可比缓存条件下，每仓 `I1.costAmount <= I0.costAmount * 1.05`。
- 输入非法直接拒绝；确定的质量/召回/成本/每任务调用越界为 failed；缺回执、实验身份不一致、币种/定价/缓存不可比或 task 集不可匹配为 inconclusive。存在确定越界时 failed 优先于 inconclusive。
- 耗时、事实 Prompt 字节、contextIncomplete 和 omitted 单独报告；超过成本门禁但质量更好的结果交用户决定，不自动采用。

## 执行前行为账本反查（强制门禁）

当前会话未暴露 CoDelphi MCP 工具；实现者在 Task 1 代码改动前必须通过可用的 `codelphi` MCP 完成以下反查，并把返回的 `stableKey`、红线场景和覆盖缺口记入执行记录。无法反查时记录阻塞并停止代码修改，不得降级为可选步骤。

```text
lookup_by_files(slug="codelphi", paths=[
  "lib/behavior-benchmark.ts",
  "scripts/measure-inventory-analysis.ts",
  "lib/behavior-inventory/types.ts",
  "lib/behavior-inventory/index.ts",
  "lib/behavior-inventory/manifest.ts",
  "lib/behavior-unit-ai.ts",
  "lib/behavior-unit-extraction.ts",
  "lib/full-analysis.ts",
  "lib/billing/cost-receipt.ts",
  "package.json"
])
get_feature_connections(slug="codelphi", path="lib/full-analysis.ts")
get_feature_connections(slug="codelphi", path="lib/behavior-unit-ai.ts")
```

执行红线：人工规格保护、证据清洗、覆盖与激活门禁、manifest 恢复、预算结算、默认 `legacy`、无虚假行为 Delta。每次 push 后用 `list_releases` 找到对应 SHA，再以 `get_release` 和 `reconcile_release` 核对预期 paths/stableKeys；计划外行为变化必须回查。

---

### Task 1: 冻结对照、实验身份与质量/成本门禁

**Files:**
- Create: `lib/pipeline-improvement-benchmark.ts`
- Create: `lib/pipeline-usage.ts`
- Create: `scripts/measure-pipeline-improvement.ts`
- Create: `scripts/export-pipeline-usage.ts`
- Create: `tests/pipeline-improvement-benchmark.test.ts`
- Create: `tests/pipeline-usage.test.ts`
- Create: `docs/benchmark/frozen/analysis-pipeline-improvement-v1.md`
- Create: `docs/benchmark/frozen/analysis-pipeline-experiment-v1.schema.json`
- Reuse: `lib/behavior-benchmark.ts`
- Reuse: `scripts/measure-inventory-analysis.ts`
- Reuse: `lib/billing/cost-receipt.ts`

**Interfaces:**
- Produces:
  - `PipelineCost = { llmCalls: number; totalTokens: number; costAmount: number; currency: string; pricingConfigHash: string; durationMs?: number }`
  - `PipelineTaskUsage = { taskKey: string; total: number; describe: number; judge: number; semanticRepair: number; reusedTerminal: boolean }`
  - `PipelineUsage = { tasks: PipelineTaskUsage[]; productSummary: number }`
  - `ImprovementRepoInput = { identity: PipelineExperimentIdentity; baseline: RepoComparison; candidate: RepoComparison; baselineCost: PipelineCost; candidateCost: PipelineCost; baselineUsage: PipelineUsage; candidateUsage: PipelineUsage }`
  - `evaluatePipelineImprovement(repos: readonly ImprovementRepoInput[]): PipelineImprovementVerdict`
  - `PipelineImprovementVerdict.status = "passed" | "failed" | "inconclusive"`
- 两份 v1 对照中 baseline.inventory=I0、candidate.inventory=I1，两者 legacy 必须是同一 `legacyResult.outputHash` 的 L。
- `export-pipeline-usage.ts` 只读 scratch 库的 `llm_call_receipts` 与 `analysis_behavior_tasks`，按 `task_key + call_stage` 导出 usage；数据库名不是 `codelphi_bench` 且不以 `_bench` 结尾时拒绝执行。

- [ ] **Step 1: 完成 MCP 反查并冻结改进协议**

在协议与 schema 中固定实验身份、L 输出复用、Prompt hash、隔离 scratch 规格、漏报冻结时点、每任务调用、成本 5% 上限、错误分类、failed/inconclusive 优先级和“验收不授权生产切换”。不得修改既有 `behavior-inventory-v1` 的冻结口径。

- [ ] **Step 2: 运行 L/I0 并冻结漏报**

在基线代码快照上按 Task 15 隔离流程运行 L 和 I0，保存 runId、输出 hash、回执和实验身份。由盲评人员识别 I0 漏报；在查看 I1 前冻结目标行为 ID、五类错误分类和严格比较运算符案例。后续不得重跑 L/I0 替换不利结果。

- [ ] **Step 3: 写失败测试**

覆盖：候选质量 passed 且修复预登记漏报、成本/token 恰为 1.05 倍时通过；召回下降、未修复目标、总调用或任一 task/stage 调用增加、成功恢复产生新调用、token/成本越界分别 failed。repo/revision/truthVersion/behaviorId/legacyHit/L outputHash 不一致，以及缺成本、定价或缓存不可比、task 集不匹配分别 inconclusive。验证 failed 优先于 inconclusive。

- [ ] **Step 4: 运行测试并确认失败**

Run: `npx vitest run tests/pipeline-improvement-benchmark.test.ts tests/pipeline-usage.test.ts`
Expected: FAIL，模块或函数尚不存在。

- [ ] **Step 5: 实现纯统计、usage 聚合与成本判定**

复用 `evaluateBehaviorNonInferiority()`，不复制 Newcombe/Wilson 算法。候选质量在全部仓库上统一计算以保留宏平均门禁；逐仓比较 inventoryHit、成本和 task usage。usage 聚合以真实回执为准，product_summary 单列，不得摊入行为 task。

- [ ] **Step 6: 实现 usage 导出和离线 CLI**

`export-pipeline-usage.ts --run-id <id> --out <usage.json>` 只读 scratch DB。`measure-pipeline-improvement.ts --experiment <experiment.json> [--out <report.json>]` 读取 descriptor 指向的两份 v1 comparison 与两份 usage，校验全部身份；退出码 0 passed、1 failed、2 inconclusive、3 输入错误，不连接数据库、不调用 AI、不修改运行模式。

- [ ] **Step 7: 运行聚焦测试**

Run: `npx vitest run tests/pipeline-improvement-benchmark.test.ts tests/pipeline-usage.test.ts tests/behavior-benchmark.test.ts`
Expected: PASS，既有 v1 判定不变。

- [ ] **Step 8: Commit**

```bash
git add lib/pipeline-improvement-benchmark.ts lib/pipeline-usage.ts scripts/measure-pipeline-improvement.ts scripts/export-pipeline-usage.ts tests/pipeline-improvement-benchmark.test.ts tests/pipeline-usage.test.ts docs/benchmark/frozen/analysis-pipeline-improvement-v1.md docs/benchmark/frozen/analysis-pipeline-experiment-v1.schema.json
git commit -m "test: add paired pipeline quality and usage gates"
```

### Task 2: manifest 静态事实契约

**Files:**
- Create: `lib/behavior-inventory/facts.ts`
- Modify: `lib/behavior-inventory/types.ts`
- Modify: `lib/behavior-inventory/index.ts`
- Modify: `lib/behavior-inventory/manifest.ts`
- Test: `tests/behavior-inventory-manifest.test.ts`
- Test: `tests/behavior-inventory.test.ts`
- Test: `tests/behavior-unit-receipts.test.ts`

**Interfaces:**
- Produces:
  - `FactResolution = { state: "resolved" } | { state: "unresolved"; reason: "non_constant_bound" | "non_finite_value" | "parse_failure" | "unsupported_syntax" | "context_incomplete" }`
  - `ConditionalBranchFact`：`kind="conditional_branch"` + `expression/conditionRange/thenRange/elseRange/hasElse`。
  - `NumericBoundFact`：`kind="numeric_bound"` + `originalExpression/normalizedExpression/operator/value/valueEvidence`；不可解析时 `value=null`。
  - `NumericDefaultFact`：`kind="numeric_default"` + `parameterName/parameterRange/value/valueEvidence`；默认值不与比较阈值混用。
  - `BehaviorCodeFact = ConditionalBranchFact | NumericBoundFact | NumericDefaultFact`。
  - `BehaviorUnit.facts?: BehaviorCodeFact[]`，兼容既有构造器，manifest 规范化时物化为数组。
  - `normalizeBehaviorFacts(facts)`、`selectFactsForTask(unit, task, maxBytes = 16_000)`。
- 通用字段固定为 `factKey/path/range/symbol/evidence/extractor/extractorVersion/resolution`；`factKey` 只承诺同 revision 确定性，不承担跨版本行为身份。
- `operator` 仅 `">" | ">=" | "<" | "<="`；规范化后值位于右侧，`100 < size` 必须表示为 `size > 100`，同时保留 originalExpression。

- [ ] **Step 1: 写失败测试**

验证 condition/then/else 区间、NumericDefault 独立类型、canonical 排序与对象属性插入顺序无关；事实不改变 unitKey/coverage 但改变 manifest hash；v2 manifest 在 schema v3 下恢复抛 `inventory_version_conflict`；空 facts 保持现有行为。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run tests/behavior-inventory-manifest.test.ts tests/behavior-inventory.test.ts tests/behavior-unit-receipts.test.ts`
Expected: FAIL，facts 契约尚不存在。

- [ ] **Step 3: 实现事实类型与 canonical 规范化**

在 `facts.ts` 定义封闭联合与校验，禁止任意字符串 kind/operator。`normalizeManifest()` 规范化 facts、全部区间和 evidence；事实只存 manifest JSON，无新数据库列。

- [ ] **Step 4: 升级 inventory schema**

将 `INVENTORY_SCHEMA_VERSION` 升为 `"3"`，使旧 run 恢复显式冲突。所有单元首版先以 `facts: []` 物化，Task 3 填充并升级 detector registry。

- [ ] **Step 5: 实现任务事实选择**

`selectFactsForTask()` 只选择与 task fragments 主区间相交的事实。类型优先级为 numeric_bound、numeric_default、conditional_branch，其后按 path、startLine、factKey；超过 16,000 UTF-8 字节时从尾部裁减，返回完整遥测：

```ts
type PromptFactTelemetry = {
  available: number;
  provided: number;
  omitted: number;
  serializedBytes: number;
  contextIncomplete: number;
  omittedByKind: Record<BehaviorCodeFact["kind"], number>;
};
```

- [ ] **Step 6: 运行聚焦测试**

Run: `npx vitest run tests/behavior-inventory-manifest.test.ts tests/behavior-inventory.test.ts tests/behavior-unit-receipts.test.ts`
Expected: PASS，包括优先级、按类型 omitted 和实际 UTF-8 字节上限。

- [ ] **Step 7: Commit**

```bash
git add lib/behavior-inventory/facts.ts lib/behavior-inventory/types.ts lib/behavior-inventory/index.ts lib/behavior-inventory/manifest.ts tests/behavior-inventory-manifest.test.ts tests/behavior-inventory.test.ts tests/behavior-unit-receipts.test.ts
git commit -m "feat: add structured static facts to behavior manifests"
```

### Task 3: TypeScript 结构化分支、边界与默认值提取器

**Files:**
- Create: `lib/behavior-inventory/detectors/typescript-facts.ts`
- Create: `tests/behavior-inventory-typescript-facts.test.ts`
- Create: `tests/fixtures/behavior-inventory/archive-limit.ts`
- Modify: `lib/behavior-inventory/index.ts`
- Modify: `lib/behavior-inventory/types.ts`
- Modify: `lib/behavior-inventory/manifest.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/behavior-inventory.test.ts`

**Interfaces:**
- Produces: `MAX_FACT_SOURCE_BYTES = 1_000_000`、`extractTypescriptBehaviorFacts(source: InventorySource): BehaviorCodeFact[]`。
- 每个可读且未超预算的 `.ts/.tsx` 文件只构建一次单文件 Program，再按单元 `primaryRanges` 分配事实。
- Expands: `BehaviorInventoryDiagnostics.factExtractionIssues: Array<{ path: string; reason: "file_too_large" | "parse_failure" }>`。非 TS/TSX 是正常不支持，不生成诊断噪音。

- [ ] **Step 1: 固定运行时依赖**

将 `typescript` 从 `devDependencies` 移到 `dependencies`，保持 package range 与锁文件 5.9.3 不变并更新 lock metadata。生产分析模块不得依赖仅测试环境可解析的 TypeScript；收尾用 standalone build 验证打包。

- [ ] **Step 2: 写失败测试与冻结 fixture**

fixture 固定 `MAX_ARCHIVE_BYTES = 500_000_000`、直接字面量、左右反转、四种关系运算符、`-1/-0.5`、默认参数、同文件常量别名、声明顺序变化、同名变量遮蔽、if/else-if/else、嵌套 if、`!`/括号/逻辑组合、NaN/Infinity、环境变量、跨文件常量、语法不完整、TSX 和超过 1,000,000 字节文件。断言 condition/then/else 区间及重复构建 canonical manifest 一致。

- [ ] **Step 3: 运行测试并确认失败**

Run: `npx vitest run tests/behavior-inventory-typescript-facts.test.ts`
Expected: FAIL，提取器尚不存在。

- [ ] **Step 4: 实现最小单文件语义提取**

使用内存 CompilerHost + `ts.createProgram({ rootNames: [source.path], options: { noResolve: true, noEmit: true }, host })`，通过 `program.getSyntacticDiagnostics()` 判断语法错误；用 TypeChecker 只定位 Identifier 的声明，以支持词法作用域正确的同文件 const/默认参数别名，不做类型推导、跨文件解析或通用常量求值。NaN、Infinity、计算表达式和环境变量保持 unresolved。

- [ ] **Step 5: 接入 inventory 与失败预算**

超过 1,000,000 UTF-8 字节记录 file_too_large；存在语法诊断记录 parse_failure 并丢弃该文件全部事实。将 `typescript-boundary-facts@1` 纳入 `DETECTOR_REGISTRY_VERSION`，在 manifest 规范化中持久化 issues；原始源码、implicit_review、覆盖门禁和其他语言路径保持原样，不增加 LLM 调用。

- [ ] **Step 6: 运行聚焦测试与构建检查**

Run: `npx vitest run tests/behavior-inventory-typescript-facts.test.ts tests/behavior-inventory.test.ts tests/behavior-inventory-manifest.test.ts`
Run: `NEXT_OUTPUT_STANDALONE=1 npm run build`
Expected: 测试 PASS，standalone 构建成功且生产分析模块可打包 TypeScript。

- [ ] **Step 7: Commit**

```bash
git add lib/behavior-inventory/detectors/typescript-facts.ts lib/behavior-inventory/index.ts lib/behavior-inventory/types.ts lib/behavior-inventory/manifest.ts package.json package-lock.json tests/behavior-inventory-typescript-facts.test.ts tests/behavior-inventory.test.ts tests/fixtures/behavior-inventory/archive-limit.ts
git commit -m "feat: extract structured TypeScript boundary facts"
```

### Task 4: AI 判定步双输入与证据范围投影

**Files:**
- Modify: `lib/behavior-unit-ai.ts`
- Modify: `lib/behavior-unit-extraction.ts`
- Modify: `lib/full-analysis.ts`
- Modify: `lib/behavioral-enumeration.ts`
- Modify: `lib/behavior-inventory/facts.ts`
- Test: `tests/behavior-unit-extraction.test.ts`
- Test: `tests/full-analysis.test.ts`

**Interfaces:**
- Consumes: `BehaviorUnit.facts`、`selectFactsForTask()` 和实际 `loadBehaviorTaskSources()` 返回的 `TaskSource[]`。
- Produces: `projectFactsForPrompt(selection, sources)`，只改变 Prompt 投影，不修改 manifest 原始事实。
- Expands: `ExtractBehaviorTaskInput.facts?: { items: BehaviorCodeFact[]; telemetry: PromptFactTelemetry }`、`JudgePromptInput.facts?: BehaviorCodeFact[]`。
- Expands: `BehaviorTaskExtractionResult.promptFacts?: PromptFactTelemetry`，聚合到 `InventoryEnumerationSummary` 的 provided/omitted/bytes/contextIncomplete/omittedByKind。
- describe 输入与调用次数不变；事实只加入 judge 和 semantic repair。

- [ ] **Step 1: 写失败测试**

断言 judge 同时含事实和原始源码、describe 不含事实段；同文件常量声明不在实际 sources 时，Prompt 中数值降为 `value=null + context_incomplete` 且 telemetry 增加，manifest 原值不变；分支区间缺失只标 contextIncomplete，不推断缺失分支结果；allowSet 不扩大。另测 16KB 优先级裁减、严格运算符、调用次数与恢复零新增调用。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx vitest run tests/behavior-unit-extraction.test.ts tests/full-analysis.test.ts`
Expected: FAIL，facts 与证据范围投影尚未接入。

- [ ] **Step 3: 实现证据范围投影**

以实际 `TaskSource.path + startLine/endLine` 判断 valueEvidence 和分支区间是否可读。数值边界/默认值的任一必要 valueEvidence 不在读取范围时，仅将 Prompt 投影降为 unresolved + context_incomplete；不得伪造新的源码证据或自动加载文件扩大 allowSet。

- [ ] **Step 4: 实现 Prompt 事实段**

以紧凑 JSON 渲染，明确：事实是结构化提示而非行为结论；AI 必须核对源码；冲突时以源码为准，无法安全判断则 unresolved；不得由未提取到效果推断无效果；不得把 `>` 改成 `>=`；场景仍须引用实际源码。只在 judge/repair 追加，避免 describe 重复支付 token。

- [ ] **Step 5: 接入编排与遥测**

full-analysis 先加载实际 sources，再选择和投影 facts，传入提取并聚合完整 PromptFactTelemetry。恢复任务复用原 result，不因新增遥测重新调用模型。

- [ ] **Step 6: 运行聚焦测试**

Run: `npx vitest run tests/behavior-unit-extraction.test.ts tests/full-analysis.test.ts tests/behavior-unit-state.test.ts`
Expected: PASS；常规 describe + judge 与既有 repair 次数不变，成功恢复零新模型调用。

- [ ] **Step 7: Commit**

```bash
git add lib/behavior-unit-ai.ts lib/behavior-unit-extraction.ts lib/full-analysis.ts lib/behavioral-enumeration.ts lib/behavior-inventory/facts.ts tests/behavior-unit-extraction.test.ts tests/full-analysis.test.ts
git commit -m "feat: ground behavior judgment with scoped static facts"
```

### Task 5: I1 shadow 验收与收尾

**Files:**
- Modify: `docs/analysis-pipeline.md`
- Modify: `docs/benchmark/frozen/analysis-pipeline-improvement-v1.md`（只记录实际结果，不改冻结阈值）
- Create locally, not necessarily commit: `artifacts/behavior-pipeline-improvement/report.json`

**Interfaces:**
- Consumes: Task 1 已冻结的 L/I0、目标漏报、usage 和实验身份，以及 Task 4 的 I1。
- Produces: 三路径质量、错误分类、token、实际成本、每 task/stage 调用、耗时、facts omitted/contextIncomplete 和过程门禁报告；不产出自动生产切换。

- [ ] **Step 1: 运行全部聚焦回归**

Run: `npx vitest run tests/pipeline-improvement-benchmark.test.ts tests/pipeline-usage.test.ts tests/behavior-benchmark.test.ts tests/behavior-inventory.test.ts tests/behavior-inventory-manifest.test.ts tests/behavior-inventory-typescript-facts.test.ts tests/behavior-unit-extraction.test.ts tests/full-analysis.test.ts tests/incremental.test.ts tests/analysis-persistence.test.ts`
Expected: PASS。

- [ ] **Step 2: 只运行候选 I1 并导出回执**

复用 Task 1 的 L/I0，不重跑。I1 使用候选代码快照、相同目标 revision 和独立激活规格，禁止继承 I0 的 AI 输出；记录 candidateCodeSha、runId、Prompt hash 和缓存条件。CoDelphi 自仓入口为 `npx tsx scripts/bench-run-once.ts inventory`，其他仓使用既有冻结入口。随后用 `export-pipeline-usage.ts` 导出 I0/I1 usage，验证 taskKey 集与逐 stage 调用。

- [ ] **Step 3: 完成匿名盲评并运行离线门禁**

由不知道路径身份的评审对匿名输出评分，并按五类错误归因；严格检查 `>`/`>=`、事实误提取、AI 误解和证据不匹配。再运行：

```bash
npx tsx scripts/measure-inventory-analysis.ts --input legacy-vs-i0.json --out legacy-vs-i0-report.json
npx tsx scripts/measure-inventory-analysis.ts --input legacy-vs-i1.json --out legacy-vs-i1-report.json
npx tsx scripts/measure-pipeline-improvement.ts --experiment experiment.json --out artifacts/behavior-pipeline-improvement/report.json
```

多仓时质量命令重复 `--input`，每仓各有 experiment descriptor。Expected: 候选质量与改进门禁均 passed；failed/inconclusive 不得启用候选，只保留报告并回到对应 Task 修复。

- [ ] **Step 4: 更新管线文档**

记录结构化分支、数值边界/默认值支持范围、1MB AST 预算、16KB Prompt 预算、contextIncomplete、schema v3、每任务成本结果和人工验收状态。若验收未执行或未通过，明确保持 `inventory` 禁用，不把单元测试通过写成 shadow 通过。

- [ ] **Step 5: 运行项目标准验证**

```bash
npm run typecheck
npm test
npm run build
git status --short
```

Expected: 全部通过；无测试日志、临时报告或构建产物被误纳入提交，用户已有未跟踪文件保持不动。

- [ ] **Step 6: 提交文档**

```bash
git add docs/analysis-pipeline.md docs/benchmark/frozen/analysis-pipeline-improvement-v1.md
git commit -m "docs: record analysis pipeline improvement validation"
```

- [ ] **Step 7: push 后行为对账**

使用 `list_releases(slug="codelphi")` 定位本次 SHA，`get_release` 核对只出现预期的分析管线/Benchmark 变化，再以 `reconcile_release` 传入实际 paths 与 MCP 反查得到的 stableKeys。计划外场景变化回查；不得把验收报告当作生产启用授权。

## 后续独立计划（不在本轮实施）

1. **依赖影响计划**：相对 import/直接调用关系、解析状态、跨 revision 增量失效，以及 `lookup_by_files` 的 D1/D2 影响结果。
2. **身份与证据生命周期计划**：Behavior/Scenario/Revision/Fingerprint 分层、split/merge、证据 stale/invalid 与 Evidence Delta。
3. **效果事实计划**：按 Benchmark 反例分别增加 DB 写入、事件发布、外部调用和权限检查提取器；每个提取器独立质量与成本门禁。
4. **跨运行缓存计划**：只有在身份、依赖失效和 Provenance 契约稳定后，才评估跨 run 结构/事实/行为缓存；首轮不以上下文缓存命中率冒充成本下降。
