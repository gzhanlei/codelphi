# 功能语义流程图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将逐场景 START 扇出替换为有证据、可校验、可版本化持久化的主链/分支语义流程图。

**Architecture:** 以最终合并场景为事实源，AI 只生成候选语义图，确定性校验后才写入派生表。版本图通过 `spec_version_id + stable_key` 映射到工作台功能，场景指纹负责失效；渲染使用 ELK 的节点、edge sections 和标签布局，图不可用时只显示场景清单。

**Tech Stack:** TypeScript、Next.js 16、React 19、Zod、MySQL 8、React Flow 12、ELK 0.12、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-12-feature-flow-semantic-graph-design.md`

## Global Constraints

- 不覆盖 `source = 'manual'` 的功能或场景，不把图数据纳入行为变更判定。
- AI 调用必须在 `saveResult()` 的数据库事务外；图生成失败不得回滚规格、差异或发布版本。
- 节点最多 24、边最多 48、独立入口最多 3；禁止未归属场景默认接 START。
- 除合成 START 外，每个节点与每条边都必须有当前功能的有效场景引用；无终态证据不得生成 END。
- 图缺失、校验失败或指纹失效时显示场景清单，不回退到旧 START 扇出。
- 每批提交前运行相关测试；最终运行 `npm run typecheck`、`npm test`、`npm run build`。
- 不执行生产回填或部署，除非用户在该阶段明确确认。

## Review Focus

- 畸形 AI 输出：重复 ID、未知场景引用、断边、孤岛和无证据 END 必须整图拒绝，见 Task 1/2。
- 说明性场景占多数：不得为了出图而降低主链要求，见 Task 1/2 的 documentary 测试。
- 人工编辑与版本映射：工作台场景变化必须使 stable_key 对应的旧图失效，见 Task 3/6。
- 布局坐标：padding 必须同时应用到节点、edge sections 和标签，见 Task 6 的几何测试。
- 规格提交后的生成失败：规格版本保持成功且只记录图失败，见 Task 4。

---

### Task 1: 语义图类型、指纹与确定性校验

**Files:**
- Create: `lib/semantic-feature-flow.ts`
- Test: `tests/semantic-feature-flow.test.ts`

**Interfaces:**
- Produces: `FeatureFlowGraph`、`SemanticFlowNode`、`SemanticFlowEdge`、`ExcludedScenario`、`FlowValidationError`。
- Produces: `scenarioFingerprint(scenarios: SpecScenario[]): string`。
- Produces: `validateFeatureFlowGraph(graph: unknown, scenarios: SpecScenario[]): FeatureFlowGraph`，非法输入抛出带 `code` 的 `FlowValidationError`。

- [ ] **Step 1: 写失败测试**

覆盖：合法主链通过；未知场景引用、重复节点 ID、断边、孤岛、4 个入口、无引用 END、无 retry 证据的回边、超过 24 节点均拒绝；只有说明性场景或一个操作节点时以 `MAIN_CHAIN_MISSING` 拒绝。另验证场景内容、step 或 source 任一变化都会改变 `scenarioFingerprint`，数组顺序变化不改变指纹。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/semantic-feature-flow.test.ts`
Expected: FAIL，模块 `lib/semantic-feature-flow` 不存在。

- [ ] **Step 3: 实现纯类型、指纹和校验**

使用 Zod 描述输入形状；指纹使用排序后的规范化场景字段与 SHA-256。图遍历从 `entryNodeIds` 开始，主链至少包含两个非 START 操作节点；除显式 retry 外拒绝环。错误返回结构化 `code` 和节点/边 ID，不返回部分图。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/semantic-feature-flow.test.ts`
Expected: 全部 PASS，无未处理异常。

- [ ] **Step 5: 提交**

```bash
git add lib/semantic-feature-flow.ts tests/semantic-feature-flow.test.ts
git commit -m "feat: validate semantic feature flow graphs"
```

### Task 2: AI 候选图生成与 RepoMap 基准

**Files:**
- Create: `lib/feature-flow-generation.ts`
- Create: `tests/feature-flow-generation.test.ts`
- Create: `tests/fixtures/repomap-performance-scenarios.json`
- Modify: `lib/ai.ts:322-409`（仅复用 `requestStructuredCompletion`，不改现有提取行为）

**Interfaces:**
- Consumes: Task 1 的 `FeatureFlowGraph`、`validateFeatureFlowGraph`。
- Produces: `generateFeatureFlowGraph(feature: SpecFeature, billing?: LlmBillingContext): Promise<FeatureFlowGraph>`。
- Produces: `featureFlowPrompt(feature: SpecFeature): string`，供 prompt 契约测试使用。

- [ ] **Step 1: 写失败测试**

用公开 RepoMap 场景制作 fixture。stub `fetch` 返回合法候选图，断言主链包含“校验→预热→测量→汇总→评估”，documentary/duplicate 场景不进入主图；返回未知引用时抛 `UNKNOWN_SCENARIO_REFERENCE`；网关失败原样抛出且回执 `callKind = "feature_flow"`。Prompt 必须要求节点/边引用场景、最多 24 节点、禁止默认 START 扇出，且不得包含 RepoMap 专用硬编码。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/feature-flow-generation.test.ts`
Expected: FAIL，`generateFeatureFlowGraph` 不存在。

- [ ] **Step 3: 实现候选生成**

`featureFlowPrompt` 只注入功能名、摘要和场景 reference/category/context/action/outcome/step/evidence 路径。调用 `requestStructuredCompletion`，再调用 Task 1 校验。billing 使用调用方上下文，`callKind = "feature_flow"`；不吞网关、解析或校验错误。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/feature-flow-generation.test.ts tests/semantic-feature-flow.test.ts`
Expected: 全部 PASS；现有 `tests/ai.test.ts` 不受影响。

- [ ] **Step 5: 提交**

```bash
git add lib/feature-flow-generation.ts tests/feature-flow-generation.test.ts tests/fixtures/repomap-performance-scenarios.json
git commit -m "feat: generate evidence-backed candidate feature flows"
```

### Task 3: 068 派生表与版本图存储

**Files:**
- Create: `migrations/068_feature_flows.sql`
- Create: `lib/feature-flow-store.ts`
- Create: `tests/feature-flow-store.test.ts`
- Modify: `tests/migrations.test.ts`

**Interfaces:**
- Produces: `SpecFeatureRecord = { id: number; stableKey: string; feature: SpecFeature }`。
- Produces: `loadVersionFeatureRecords(execute: Execute, versionId: number): Promise<SpecFeatureRecord[]>`。
- Produces: `saveFeatureFlowGraph(execute: Execute, specFeatureId: number, graph: FeatureFlowGraph, fingerprint: string): Promise<void>`。
- Produces: `loadFeatureFlowGraphs(execute: Execute, versionId: number, features: SpecFeature[]): Promise<Map<string, FeatureFlowGraph>>`，key 为 `specFeatureKey(feature.name)`。
- Produces: `copyInheritedFeatureFlowGraphs(execute: Execute, previousVersionId: number, nextVersionId: number): Promise<number>`，仅复制 stable_key 和指纹都一致的图。

- [ ] **Step 1: 写失败测试**

stub `Execute` 模拟版本功能、场景和图行。验证 upsert；加载时指纹不一致不返回图；stable_key 相同但场景不同不复制；stable_key 与指纹均一致才复制；工作台手工 source 变化同样使旧图失效。检查 migration 只新增 `spec_feature_flows`，含主键外键、graph_json、scenario_fingerprint 和时间字段。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/feature-flow-store.test.ts`
Expected: FAIL，存储模块不存在。

- [ ] **Step 3: 实现 migration 与存储**

`spec_feature_flows.spec_feature_id` 主键并 `ON DELETE CASCADE`。存储层负责 ID/stable_key 查询，工作台与版本功能通过 stable_key 而非 ID 关联。复制过程读取两个版本的记录并逐键比较指纹，不盲目复制。

- [ ] **Step 4: 运行测试与迁移静态校验**

Run: `npx vitest run tests/feature-flow-store.test.ts tests/migrations.test.ts && npm run typecheck`
Expected: PASS；MySQL 8 SQL 无 PostgreSQL 语法，migration 068 的派生表契约测试通过。

- [ ] **Step 5: 提交**

```bash
git add migrations/068_feature_flows.sql lib/feature-flow-store.ts tests/feature-flow-store.test.ts tests/migrations.test.ts
git commit -m "feat: persist versioned semantic feature flows"
```

### Task 4: 分析后同步与事务外失败隔离

**Files:**
- Create: `lib/feature-flow-service.ts`
- Create: `tests/feature-flow-service.test.ts`
- Modify: `lib/analysis.ts:526-527`

**Interfaces:**
- Consumes: Task 2 的 `generateFeatureFlowGraph`、Task 3 的全部存储接口。
- Produces: `syncFeatureFlowsForVersion(options: { specVersionId: number; repositoryId: number; affectedKeys?: ReadonlySet<string> | null; billing?: LlmBillingContext }): Promise<{ generated: number; copied: number; failed: number }>`。
- Produces: `regenerateFeatureFlowForWorkbenchFeature(featureId: number, billing?: LlmBillingContext): Promise<FeatureFlowGraph>`，供 Task 5 使用。

- [ ] **Step 1: 写失败测试**

验证：全量模式生成全部最终场景图；增量模式只生成 affectedKeys；未受影响且指纹一致的图复制；单功能 AI/校验失败只增加 failed，不抛错、不回滚；`regenerateFeatureFlowForWorkbenchFeature` 用 workbench feature ID 找最新版本及 stable_key，并以工作台最终场景生成。明确断言 `saveResult()` 返回后才调用同步函数。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/feature-flow-service.test.ts`
Expected: FAIL，同步服务不存在。

- [ ] **Step 3: 实现同步服务并接入分析**

同步服务内部查上一版本并复制继承图，再按 stable_key 过滤当前记录。并发生成上限 3，单功能失败记录 `console.error` 结构化原因后继续。`analysis.ts` 在 `saveResult()` 返回（事务已 commit）后调用并 `await syncFeatureFlowsForVersion`，billing 为 `{ runId: run.id, accountId: run.accountId ?? null, chargeComponent: "main", callKind: "feature_flow" }`。

- [ ] **Step 4: 运行相关测试**

Run: `npx vitest run tests/feature-flow-service.test.ts tests/analysis-persistence.test.ts tests/analysis-run.test.ts`
Expected: 全部 PASS；生成失败不改变既有规格结果。

- [ ] **Step 5: 提交**

```bash
git add lib/feature-flow-service.ts tests/feature-flow-service.test.ts lib/analysis.ts
git commit -m "feat: sync semantic flows after spec commit"
```

### Task 5: 按工作台功能显式回填

**Files:**
- Create: `scripts/feature-flow-backfill.ts`
- Create: `tests/feature-flow-backfill.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `regenerateFeatureFlowForWorkbenchFeature(featureId, billing)`。
- CLI: `npx tsx scripts/feature-flow-backfill.ts --feature-id 9176`；仅支持一个正整数 ID，缺失或非法参数退出 2。

- [ ] **Step 1: 写失败测试**

覆盖合法参数调用一次服务；缺失、非数字、0、负数、多个 feature-id 均退出 2 且不调用服务；生成失败退出 1 并输出功能 ID，不打印秘密。billing 为 `{ runId: null, accountId: null, chargeComponent: "main", callKind: "feature_flow_backfill" }`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/feature-flow-backfill.test.ts`
Expected: FAIL，脚本不存在。

- [ ] **Step 3: 实现薄 CLI**

将参数解析与执行导出以便测试，脚本入口仅在直接运行时执行。输出 specVersionId、节点/边数和排除场景数；不执行全库回填，不在 GET 页面中调用。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/feature-flow-backfill.test.ts tests/feature-flow-service.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/feature-flow-backfill.ts tests/feature-flow-backfill.test.ts
git commit -m "feat: backfill semantic flow for one workbench feature"
```

### Task 6: 语义图加载、ELK 路由与无扇出回退

**Files:**
- Modify: `lib/product-details.ts:151-229`
- Modify: `components/spec-workspace-content.tsx`
- Modify: `components/spec-workspace.tsx`
- Modify: `components/feature-detail.tsx`
- Rewrite: `components/feature-flow.tsx`
- Rewrite: `lib/feature-flow-layout.ts`
- Rewrite: `tests/feature-flow-layout.test.ts`
- Rewrite: `tests/feature-flow.test.ts`
- Delete: `lib/feature-flow.ts`（确认无其他引用后删除旧构建器）

**Interfaces:**
- Consumes: Task 1 的 `FeatureFlowGraph`、Task 3 的 `loadFeatureFlowGraphs`。
- Produces: `layoutSemanticFeatureFlow(graph: FeatureFlowGraph): Promise<{ nodes: PositionedSemanticFlowNode[]; edges: RoutedSemanticFlowEdge[]; width: number; height: number }>`。
- `PositionedSemanticFlowNode` 增加 `x/y/width/height`；`RoutedSemanticFlowEdge` 增加 `points: ElkPoint[]` 与可选 `labelPosition: ElkShape`。
- 页面 `getProductDetails()` 增加 `featureFlows: Map<string, FeatureFlowGraph>`，组件沿现有 props 传递并按 `specFeatureKey(feature.name)` 读取。

- [ ] **Step 1: 写失败测试**

布局使用带分支、回边和长标签的图：断言纵向主链、节点不重叠、路径不穿节点、标签不碰撞、长标题高度足够；padding 同时体现在节点、edge sections 和标签坐标。组件测试覆盖：无图只显示清单原因、聚合场景详情、documentary 独立区域、无 START 扇出、长文本不裁切。产品详情测试覆盖 stable_key 映射与指纹失效。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/feature-flow-layout.test.ts tests/feature-flow.test.ts tests/product-details.test.ts`
Expected: FAIL，语义布局与页面图数据尚不存在。

- [ ] **Step 3: 实现布局与 RoutedEdge**

ELK 输入包含节点测量尺寸、边及标签尺寸，使用 DOWN、ORTHOGONAL 和标签间距。输出直接使用 edge sections；所有坐标统一加同一个 padding。React Flow 自定义 RoutedEdge 用 `BaseEdge` 绘制 points，用 `EdgeLabelRenderer` 放置标签，不再使用 SmoothStep 或 fanout 类型。

- [ ] **Step 4: 接入页面与回退**

`getProductDetails()` 对最终 `SpecFeature[]` 调用 `loadFeatureFlowGraphs` 并返回 map。`FeatureFlow` 只接收已验证 graph，不再调用 `buildFeatureFlow`；无图时显示“暂无通过校验的语义流程图，或场景已变化”。节点详情按 scenarioRefs 聚合原始场景，排除场景独立展示原因。删除旧构建器与 fanout 代码。

- [ ] **Step 5: 运行相关测试**

Run: `npx vitest run tests/feature-flow-layout.test.ts tests/feature-flow.test.ts tests/product-details.test.ts tests/demo-anonymous-read.test.ts && npm run typecheck`
Expected: 全部 PASS；无 `buildFeatureFlow` 或 START fanout 残留引用。

- [ ] **Step 6: 提交**

```bash
git add lib/product-details.ts lib/feature-flow-layout.ts components/spec-workspace-content.tsx components/spec-workspace.tsx components/feature-detail.tsx components/feature-flow.tsx lib/feature-flow.ts tests/feature-flow-layout.test.ts tests/feature-flow.test.ts tests/product-details.test.ts
git commit -m "feat: render routed semantic feature flows"
```

### Task 7: 全量验证、文档与显式上线闸门

**Files:**
- Modify: `docs/w-decision-scenario-sequence-plan.md`
- Modify: `docs/superpowers/specs/2026-11-12-feature-flow-semantic-graph-design.md`（只更新实施状态，不改验收口径）
- Modify: `docs/docker-migration-plan.md`（补充本次镜像与回填结果）

- [ ] **Step 1: 运行完整本地门禁**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck 0 错误、全部测试文件 0 真实失败、生产构建成功。

- [ ] **Step 2: 在本地或隔离数据上验证生成与布局**

用 RepoMap「固定性能门槛」执行单功能回填，确认候选图通过校验且主链符合规格；同时验证一个无有效主链的功能只显示清单。检查 LLM 回执为 `feature_flow` / `feature_flow_backfill`，无秘密日志。

- [ ] **Step 3: 在隔离环境执行既有重放**

经用户确认重放环境与 AI 费用后，按 W-DECISION 口径运行 `npx tsx scripts/bm1-run.ts`，并执行现有增量重放与盲评判定脚本。记录召回、精确率和 FUR；召回目标 ≥80% 且不得回退、精确率不得回退、FUR=0。若基线环境不可用，明确记录未验证项，不得用单元测试替代该结论。

- [ ] **Step 4: 更新文档并提交**

记录实现提交、迁移、生成成功/失败数、测试结果和仍未覆盖的限制。不得把未运行的 WD-4 或生产验收写成已通过。

```bash
git add docs/w-decision-scenario-sequence-plan.md docs/superpowers/specs/2026-11-12-feature-flow-semantic-graph-design.md docs/docker-migration-plan.md
git commit -m "docs: record semantic feature flow implementation"
```

- [ ] **Step 5: 经用户明确确认后部署与回填**

构建 `codelphi-server:sha-<commit>`，按 `docs/docker-migration-plan.md` 传输并运行 `deploy.sh`；确认 migration 068 与容器健康。只对工作台 feature `9176` 执行单功能回填，不做全库回填。

- [ ] **Step 6: 生产验收**

访问 `/products/u-a8811be775/repomap?view=spec&feature=9176&mode=flow`，确认主链、分支和终态清晰且无 START 平行扇出；检查节点/标签不互相穿过、长文本不裁切、详情证据可点击、缩放与 fitView 正常。复测「超管手工充值」和 390px 窄屏。部署失败使用部署状态中的上一健康镜像回滚，派生图数据不影响场景。
