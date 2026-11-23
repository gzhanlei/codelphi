# Legacy GUARD 行为锚点独立实验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用四组各 3 次的独立 CB-18 对照实验，验证 GUARD 锚点能否在不增加 LLM 调用、总 token 和实际费用的情况下提高行为召回。

**Architecture:** 新增仅用于实验的 `if / throw` 锚点提取器、四臂 Prompt 投影和离线判定器；生产 `lib/ai.ts` 与现有分析流程不改。A 使用原始 Prompt，B 仅压缩，C 仅加锚点，D 压缩并加锚点；独立评审真值和输出后，使用真实回执判定，失败即关闭候选。

**Tech Stack:** TypeScript 编译器 API、Vitest 4、现有 `buildAnalysisMessages` / `parseAnalysisContent` / LLM usage 与定价回执、独立 scratch JSON 产物。

**Spec:** `docs/superpowers/specs/2026-11-23-legacy-guard-anchor-experiment-design.md`

## Global Constraints

- 只提取明确的 `if / throw` 结构；不处理 return 错误、正向激活条件、跨文件守卫或通用调用关系。
- 锚点缺失不改变原始源码、分析范围或输出；原始源码和证据 allowSet 不变，锚点自身不充当证据。
- 使用 `extraction = "complete" | "partial"`，不使用 `resolution`；锚点不直接生成场景、规格或 Behavior Delta。
- A/B/C/D 固定相同 commit、源码、模型、参数、输入证据和 Schema；每组 3 次，保存全部 12 次结果，不挑样本。
- CB-18 与 CB-30 真值必须由未参与实现的独立评审确认；CB-34 排除，不用锚点反写真值。
- 成本包括主调用、repair、重试、输入/输出、缓存与供应商单独计费项；缺失或不可比即 inconclusive。
- D 必须满足 `llmCalls <= A`、`inputTokens + outputTokens <= A`、`actualCost <= A`，且非锚点/整体召回不回退、虚假行为和 Delta 不增加。
- 不建设新事实表、跨文件依赖、通用事实管线或生产开关；不部署。每次提交前运行 `npm run typecheck`、`npm test`、`npm run build` 并检查 `git status`，不提交运行产物或用户已有未跟踪文件。

## Review Focus

- 非 throw、正向条件和跨文件语义不得被误提取或猜测；锚点缺失不得影响原输出——Task 1。
- 匿名/不完整结构只能是 partial 或无锚点，不能标 complete——Task 1。
- B/C/D 只能改变各自声明的 Prompt 内容，原始源码与 allowSet 不变——Task 2。
- 非锚点召回、虚假行为和独立评审缺失不得被 CB-18 单点命中掩盖——Tasks 2、3。
- repair、隐藏推理 token、缓存/定价不可比不得被成本统计遗漏——Tasks 2、3。

---

### Task 1: 最小 GUARD 锚点提取器

**Files:**
- Create: `lib/legacy-analysis/guard-anchors.ts`
- Create: `tests/legacy-guard-anchors.test.ts`

**Interfaces:**
- Produces:
  - `GuardAnchor = { kind: "GUARD"; path: string; symbol: string; condition: string; outcome: string; extraction: "complete" | "partial"; evidence: { path: string; startLine: number; endLine: number } }`
  - `extractLegacyGuardAnchors(source: { path: string; content: string }): GuardAnchor[]`

- [ ] **Step 1: 写失败测试**

在 `tests/legacy-guard-anchors.test.ts` 固定：
- CB-18 形式的 `if (latestRunId !== run.id) throw new Error("Analysis superseded")` 返回一个 complete GUARD，保留函数名、原始条件、throw 文本与真实行号。
- `if (!isAuthorized(user)) return ...` 和 `if (isLatestRun(run)) await activate(run)` 不返回锚点。
- 跨文件 `isLatestRun(run)` 作为 throw 条件时只记录表达式文本，不解释跨文件含义。
- 匿名函数中的 GUARD 为 partial；语法错误或超过 1,000,000 UTF-8 字节时整文件无锚点并记录原因。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/legacy-guard-anchors.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现最小提取器**

在 `lib/legacy-analysis/guard-anchors.ts` 使用单文件内存 Program 与 `getSyntacticDiagnostics()`，只遍历 `IfStatement` 且 then 分支为 `ThrowStatement` 的节点。函数名未知时标 partial；不得从函数名、条件或异常文本推断产品行为。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/legacy-guard-anchors.test.ts`
Expected: 全部 PASS，并验证非 throw/正向条件没有误报。

- [ ] **Step 5: 提交**

```bash
git add lib/legacy-analysis/guard-anchors.ts tests/legacy-guard-anchors.test.ts
git commit -m "test: add scoped legacy guard anchor extractor"
```

### Task 2: 四臂 Prompt 与离线质量成本门禁

**Files:**
- Create: `lib/legacy-analysis/guard-prompt.ts`
- Create: `lib/legacy-analysis/guard-evaluation.ts`
- Create: `tests/legacy-guard-prompt.test.ts`
- Create: `tests/legacy-guard-evaluation.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GuardAnchor[]`；现有 `buildAnalysisMessages`。
- Produces:
  - `GuardExperimentArm = "A" | "B" | "C" | "D"`
  - `buildLegacyGuardExperimentMessages(input: { arm: GuardExperimentArm; sources; change; anchors: GuardAnchor[] }): StructuredCompletionMessage[]`
  - `GuardRunMeasurement = { arm, repetition: 1 | 2 | 3, cb18Hit: boolean, nonAnchorHits: number, overallHits: number, falsePositives: number, falseDeltas: number, llmCalls: number, inputTokens: number, outputTokens: number, actualCost: number, pricingVersion: string, cacheCondition: string, independentlyReviewed: boolean, evidenceAllowSetUnchanged: boolean, manualProtected: boolean }`
  - `evaluateLegacyGuardExperiment(runs: GuardRunMeasurement[]): { status: "passed" | "failed" | "inconclusive"; reasons: string[] }`

- [ ] **Step 1: 写 Prompt 失败测试**

验证：
- A 与直接调用 `buildAnalysisMessages` 完全一致。
- B 只做三个冻结替换：压缩覆盖要求、每功能场景要求、证据要求；原始代码段逐字不变。
- C 只在原始 Prompt 的 commit 与 code section 之间插入锚点，不执行 B 的替换。
- D 同时执行 B/C；锚点最多 3 条，按 `supersed|latest|activat`（3 分）、`permission|authoriz`（2 分）、`payment|billing|quota`（1 分）降序，再按 path/startLine 升序。
- C/D 使用 `extraction` 而非 `resolution`，原始源码只出现一次，输入路径集合不变。

三个冻结替换为：
- 覆盖长句 → `覆盖输入中的全部主要用户功能，逐个检查页面、API、组件和业务模块，不得只总结提交或遗漏独立模块。`
- 场景长句 → `覆盖全部主要功能；每功能保留 1-5 个关键场景。`
- 证据长句 → `场景、审计候选和产品简介均须附输入文件的 path:startLine 证据；无内部审计时 changes=[]。`

- [ ] **Step 2: 写离线门禁失败测试**

用手工构造的每组 3 次测量验证：
- 合法结果满足 C>A、B 无回退、D≥C 且 D>B、D 的非锚点/整体召回不低于 A、虚假指标不增加且成本不增加时 passed。
- A 三次全部命中时判为没有可证明的改进空间；C 无 CB-18 改善、B 非锚点回退、D 非锚点回退、D 调用/token/费用任一增加均 failed。
- usage 缺失、定价或缓存不可比、未独立评审均 inconclusive。
- `evidenceAllowSetUnchanged=false` 或 `manualProtected=false` 均 failed。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/legacy-guard-prompt.test.ts tests/legacy-guard-evaluation.test.ts`
Expected: FAIL，两个模块不存在。

- [ ] **Step 4: 实现四臂 Prompt 与离线判定器**

`guard-prompt.ts` 只包装现有消息构建，不修改 `lib/ai.ts`。`guard-evaluation.ts` 只读手工/独立评审测量，按同组 3 次合计成本；failed 优先于 inconclusive，不根据锚点文本自动判 CB-18 命中。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/legacy-guard-prompt.test.ts tests/legacy-guard-evaluation.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add lib/legacy-analysis/guard-prompt.ts lib/legacy-analysis/guard-evaluation.ts tests/legacy-guard-prompt.test.ts tests/legacy-guard-evaluation.test.ts
git commit -m "test: add four-arm legacy guard experiment gate"
```

### Task 3: 冻结真值、执行 12 次对照并出具体验收结果

**Files:**
- Create: `docs/benchmark/frozen/legacy-guard-anchor-truth-v1.json`
- Create: `docs/benchmark/frozen/legacy-guard-anchor-config-v1.json`
- Create: `scripts/legacy-guard-anchor-experiment.ts`
- Create: `tests/legacy-guard-experiment-script.test.ts`
- Create: `docs/benchmark/frozen/legacy-guard-anchor-v1-result.md`

**Interfaces:**
- Consumes: Task 1 锚点、Task 2 四臂 Prompt 和 `evaluateLegacyGuardExperiment`；现有 `requestStructuredCompletionDetailed`、`parseAnalysisContent`、usage 与定价函数。
- Produces: 可重放的 12 次调用原始结果（git-ignored workspace）、独立评审 judgments 和含 `adoptionReady` 的结果文档。

- [ ] **Step 1: 冻结独立真值与配置**

真值只包含：
- CB-18：只有最新 run 可激活规格，旧 run 不覆盖新 run 的结果，证据 `lib/analysis.ts:62-66`。
- CB-30（非锚点）：边际场景增益严格 `< epsilon` 才停止，增益有上限，证据 `lib/analysis.ts:577-610` 与 `lib/env.ts`。

配置固定 revision `2659429e588da466fcb712ba096531343aa75d08`、源码 `lib/analysis.ts:1-610`、CB-30 所需 `lib/env.ts`、模型/参数、四臂各 3 次、Prompt hash 和输出 Schema。未参与实现的独立评审先确认真值并记录 `independentlyReviewed=true`；未确认不得调用 LLM。

- [ ] **Step 2: 写脚本失败测试**

验证输入校验：缺真值评审、非 4 臂×3 次、usage 缺失、pricing 不可比时不得给出 passed；脚本只对错误输入 fail closed，不实际调用 AI。验证输出包含每次 arm/repetition、原始输出、全部 usage、repair/重试计数和成本口径。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/legacy-guard-experiment-script.test.ts`
Expected: FAIL，脚本/运行辅助不存在。

- [ ] **Step 4: 实现可重放实验脚本**

`scripts/legacy-guard-anchor-experiment.ts` 从本地 git revision 读取冻结源码，依次运行 A/B/C/D 各 3 次，不重试、不挑样本；真实 usage 解析失败或定价不可比时停止并写 inconclusive。原始结果写 `.superpowers/sdd/2026-11-23-legacy-guard-anchor-experiment/`，不写生产数据库。

- [ ] **Step 5: 执行对照并独立评审**

先运行脚本测试，再运行 12 次真实调用。由未参与实现的独立评审判断 CB-18、CB-30、整体召回、虚假行为/Delta、证据与人工保护；未评审则结果只能为 inconclusive。不得用锚点文本自动给 CB-18 计命中。

- [ ] **Step 6: 运行离线门禁并记录结果**

运行 Task 2 判定器，结果文档分别列出四臂的 CB-18、非锚点、整体召回、虚假指标、调用、输入/输出 token、repair、缓存和实际费用。只有全部 spec 门禁通过才写 `adoptionReady=true`；否则关闭候选，不扩大规则。

- [ ] **Step 7: 全量验证并提交**

```bash
npx vitest run tests/legacy-guard-anchors.test.ts tests/legacy-guard-prompt.test.ts tests/legacy-guard-evaluation.test.ts tests/legacy-guard-experiment-script.test.ts
npm run typecheck
npm test
npm run build
git add docs/benchmark/frozen/legacy-guard-anchor-truth-v1.json docs/benchmark/frozen/legacy-guard-anchor-config-v1.json scripts/legacy-guard-anchor-experiment.ts tests/legacy-guard-experiment-script.test.ts docs/benchmark/frozen/legacy-guard-anchor-v1-result.md
git commit -m "test: evaluate legacy guard anchors under bounded cost"
```

Expected: 工程验证 PASS；结果以真实四臂验收为准，工程测试不得冒充 shadow 通过。清理运行生成的临时文件，不提交原始输出、token 或凭证。
