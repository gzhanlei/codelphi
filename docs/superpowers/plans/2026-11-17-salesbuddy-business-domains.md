# SalesBuddy 业务领域映射与迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SalesBuddy 首屏按业务价值展示能力，同时保留全部技术规格、原始功能身份和证据，并提供可 dry-run、可备份、可回滚的数据迁移。

**Architecture:** 复用现有 `features.parent_id` 两级功能树，人工创建 6 个业务父节点并只更新子功能的 `parent_id`。读取层把有子级的父节点投影为业务卡片并聚合场景；没有分组的产品保持现状。迁移脚本负责校验、备份、事务写入与回滚，不引入 AI、业务对象模型或新数据库字段。

**Tech Stack:** TypeScript、Next.js App Router、React Server Components、MySQL 8、Vitest、现有 `mysql2/promise`、现有 Docker 部署。

**Spec:** 本文件「领域映射与迁移契约」，依据 SalesBuddy 多角色评审及 2026-11-17 生产只读快照（`product_id=6`，45 个 active 功能）。

## Global Constraints

- 不新增 schema、业务对象模型、角色仪表盘或 Agent 工作流；允许 AI 提出项目自有业务域候选，但未经人工审核不得激活分类或改变首页。
- 业务父节点是各项目自己的产品知识，不设全局枚举或通用业务分类；SalesBuddy 的 22 个 ID 仅用于一次性迁移，不得作为其他项目的默认值。
- 没有父子分组的项目始终回退到现有功能卡片，不强制分组；AI 根据项目说明、功能、场景和证据提出候选，项目维护者只审核、修改和确认，不从零整理。
- 原功能 `id`、`name`、`display_name`、`summary`、`source`、`verified_at/by`、`last_edited_at/by`、场景、证据与发布历史全部保持不变。
- 新父节点使用 `source='manual'`、`parent_id=NULL`、`active=1`、`verified_at/by=NULL`；不伪造人工确认。
- 子功能只改 `parent_id`，不得借 `updateFeature` 将其改为 manual 或清除核实状态。
- 未分组的 23 个技术/运维功能留在完整规格，不进入业务首页分组。
- 问答建议继续使用有实际场景的原始功能名，不拿新父级名称代替检索身份。
- 「已发现证据」不得表述为完整实现；测试文件存在不得表述为测试通过。
- 生产写入必须先 dry-run、人工审阅并生成备份；回滚只软下线新父节点并恢复原 `parent_id`，不硬删除。
- 提交前运行 `npm run typecheck`、`npm test`、`npm run build`。
- CoDelphi MCP 当前不可用；发布后使用只读发布数据核对，并明确不能声称完成 MCP 对账。

## 新项目的接入方式

- 默认不创建任何已确认父节点，保持现有平铺核心能力卡片。
- 需要业务导航时，AI 根据当前项目提出父节点及子功能归属，项目维护者只审核、修改或拒绝；这些分类没有跨项目复用义务。
- 例如 AI 可以为 Tingfeng 提议「声音采集与监测」「声音标签与展示」「隐私与合规」「国际化」「验证与发布」，但这只是候选示例，未经确认不影响其现有首页。
- 通用代码只负责「如果有已确认父子分组则聚合展示」，不读取 SalesBuddy 的域名、ID 或分类常量。

## Review Focus

- 未分组产品回退：没有父子分组时，CoDelphi/RepoMap 的卡片、排序和问答建议必须与现状一致（Task 1/2）。
- 聚合口径：父级自身场景和直接子级场景各计一次，不遗漏、不按名称重复计数（Task 1）。
- 检索身份：业务卡片使用显示名，问答仍用原始功能 `canonicalName`（Task 2）。
- 数据漂移：未知 ID、重复 ID、已有父级、目标父级冲突或子功能已被其他任务移动时，整个迁移必须中止（Task 3/4）。
- 证据过度表达：实现文件只能称为已发现证据，不能暗示完整实现或测试已执行（Task 2）。
- 回滚保真：回滚恢复原父子关系，保留全部 source、核实状态和场景，不硬删除新父节点（Task 4/5）。

---

## 领域映射与迁移契约

### 新父节点

| key | name / display_name | summary |
| --- | --- | --- |
| communication | 客户沟通 | 汇总面谈、邮件、微信、录音笔与速记等客户沟通来源。 |
| cognition | 客户认知 | 通过转写、复盘与持续积累形成客户档案和客户理解。 |
| opportunity | 商机管理 | 了解购买意愿、商机进展及其沟通来源。 |
| promise | 承诺管理 | 识别双方承诺并跟踪履约和逾期情况。 |
| execution | 销售执行 | 管理后续跟进、日历、待办与通知。 |
| team | 团队管理 | 通过管理者视图了解团队客户进展与协作情况。 |

新父节点 ID 由数据库生成，迁移计划不得预写固定 ID。

### 进入业务分组的 22 个现有功能

| 功能 ID | 原功能名 | 目标域 | 当前场景数 |
| --- | --- | --- | ---: |
| 15118 | Agent 邮箱与微信记录入库 | communication | 3 |
| 71 | 多源沟通录入与录音 | communication | 4 |
| 15138 | 录音地点反查 | communication | 3 |
| 299 | AI 助理自然语言问答 | cognition | 1 |
| 15122 | ASR 多引擎评测与对比 | cognition | 4 |
| 15123 | ASR 转写质量评估 | cognition | 3 |
| 15127 | 个人客户升格与主档收尾 | cognition | 4 |
| 15133 | 客户主档与身份归一 | cognition | 4 |
| 15134 | 客户洞察与凝结候选 | cognition | 2 |
| 298 | 客户记忆与证据台账 | cognition | 3 |
| 15150 | 沟通参与方识别与评测 | cognition | 4 |
| 15153 | 相关性闸门离线评估 | cognition | 3 |
| 15157 | 说话人别名推断 | cognition | 2 |
| 72 | 转写与 AI 复盘 | cognition | 3 |
| 15161 | 销售话术知识蒸馏 | cognition | 2 |
| 15129 | 商机与来源谱系 | opportunity | 2 |
| 15130 | 商机归属与建议抑制 | opportunity | 4 |
| 15160 | 邮件承诺提取与履约检测 | promise | 4 |
| 77 | 日历与提醒 | execution | 2 |
| 15139 | 待办完成状态与系统观察 | execution | 4 |
| 15154 | 站内通知 | execution | 2 |
| 74 | 管理者视图与团队协作 | team | 3 |

预期业务卡片顺序：客户认知（35）、客户沟通（10）、销售执行（8）、商机管理（6）、承诺管理（4）、团队管理（3）。场景数只用于排序，不代表业务覆盖率或质量评分。

### 不分组的 23 个技术与运维功能

以下功能保持 `parent_id=NULL`，只在完整规格中出现：

`15117` Agent Mail 运维观察、`15119` Agent 邮箱地址迁移、`15121` Android 安装包分发、`15124` iOS 端集成与内购、`305` Web 管理后台、`14951` Web 设计画布与多方向视觉方案、`15128` 产品演示视频生成、`15131` 备份异地归档、`15135` 客户租户迁移与运维脚本、`15137` 录音删除级联清理、`78` 数据安全与合规、`15140` 支付与渠道对接、`15142` 数据库迁移与运维修复、`15143` 数据库迁移环境、`14956` 暖纸方向客户管理页、`14957` 暖纸方向工作汇报页、`14958` 暖纸方向待办日历页、`14959` 暖纸方向营销落地页、`15149` 服务端部署与运行、`15151` 演示数据与运维部署、`15152` 生产环境启动安全校验、`304` 许可证与订阅、`301` 账号与登录。

---

### Task 0: AI 生成项目专属业务分组候选

**Files:**
- Create: `lib/business-domain-candidates.ts`
- Create: `app/api/products/[slug]/domain-candidates/route.ts`
- Create: `components/domain-candidate-review.tsx`
- Create: `tests/business-domain-candidates.test.ts`

**Interfaces:**
- Consumes: 产品说明、功能名称与概述、场景文本和现有证据路径；不把其他项目的分类作为 prompt 模板。
- Produces: 3–8 个候选 `{ name, summary, featureIds, evidencePaths, unknowns }[]`，每项 `source='generated'`；只有审核通过后才转换为 Task 3 的迁移输入。

- [ ] **Step 1: 写失败测试**

- 两个不同产品输入产生各自不同的候选，不复用 SalesBuddy 分类。
- 候选只能引用现有 feature ID；未知 ID、空候选或证据缺失时返回 unknown，不激活分组。
- AI 输出无法解析、调用失败或用户拒绝时，数据库和现有首页完全不变。
- 候选明确显示 AI 来源和证据，不标记为已核实。

- [ ] **Step 2: 验证测试失败**

Run: `npx vitest run tests/business-domain-candidates.test.ts`
Expected: FAIL，候选生成与审核投影不存在。

- [ ] **Step 3: 实现候选生成与只读审核界面**

AI 负责提出父节点、用户价值概述和子功能归属；界面允许整体接受、逐项修改和拒绝。候选不直接写 `parent_id`，不替换当前首页。只有确认操作才生成 Task 3 的迁移计划；父节点确认后为 manual，子功能 source 保持不变。

- [ ] **Step 4: 验证测试通过**

Run: `npx vitest run tests/business-domain-candidates.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/business-domain-candidates.ts app/api/products/[slug]/domain-candidates/route.ts components/domain-candidate-review.tsx tests/business-domain-candidates.test.ts
git commit -m "feat: propose project-specific business domains"
```

### Task 1: 业务分组投影

**Files:**
- Create: `lib/business-domains.ts`
- Create: `tests/business-domains.test.ts`

**Interfaces:**
- Consumes: `FeatureRow[]`、`ScenarioRow[]`（`lib/types.ts`）。
- Produces: `buildBusinessDomainCards(features, scenarios, productBase)`，返回 `{ id, canonicalName, name, summary, source, scenarioCount, href }[]`；`href` 由 `productBase` 与现有 `featureHref(id)` 组合。

- [ ] **Step 1: 写失败测试**

覆盖：
- 两个父节点各含直接子级，场景数等于父级自身场景加直接子级场景；只含直接子级，不递归第三层。
- 同一子级只计一次，排序按场景数降序、再按 `canonicalName`。
- `name` 使用 `displayName || name`，`canonicalName` 保持原名。
- 没有任何父级带子级时返回空数组。

- [ ] **Step 2: 验证测试失败**

Run: `npx vitest run tests/business-domains.test.ts`
Expected: FAIL，找不到 `buildBusinessDomainCards`。

- [ ] **Step 3: 实现纯函数**

只接收数据，不读数据库、不调用 AI。输入为空或没有父子分组时返回空数组。

- [ ] **Step 4: 验证测试通过**

Run: `npx vitest run tests/business-domains.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/business-domains.ts tests/business-domains.test.ts
git commit -m "feat: add business domain projection"
```

### Task 2: 首页分组、问答回退与证据措辞

**Files:**
- Modify: `lib/product-overview.ts`
- Modify: `components/product-overview.tsx`
- Modify: `lib/ui-strings/product.ts`
- Modify: `tests/product-overview.test.ts`
- Modify: `tests/product-overview-component.test.ts`
- Create: `tests/feature-detail.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `buildBusinessDomainCards`。
- Produces: `ProductOverviewData.questionCapabilities`，保留原始 `canonicalName` 供 `SpecAsk` 使用；有分组时 `capabilities` 为业务卡片，无分组时保持原卡片。

- [ ] **Step 1: 写失败测试**

- 有分组时，首页只出现业务父级，未分组技术功能不出现在 `capabilities`，但仍保留在完整规格输入中。
- 无分组时，现有 `capabilities` 与 `questionCapabilities` 顺序、名称、链接和问答建议不变。
- 父级无场景时，问答从有场景的原始子功能产生，不使用父级名称。
- 组织用父节点不进入普通「需要确认」列表，原始功能和场景仍按原规则处理。
- `FEATURE_DETAIL.implementationFiles` 显示「已发现证据（不代表完整实现）」，且不包含「实现分布」。

- [ ] **Step 2: 验证测试失败**

Run: `npx vitest run tests/product-overview.test.ts tests/product-overview-component.test.ts tests/feature-detail.test.ts`
Expected: FAIL，业务分组与 `questionCapabilities` 尚未实现，证据文案仍为「实现分布」。

- [ ] **Step 3: 集成投影与文案**

有业务卡片时替换 `capabilities`；否则沿用现有逻辑。`questionCapabilities` 始终从有实际场景的原始功能生成。只改展示，不改变 feature/scenario/release 数据。

- [ ] **Step 4: 验证相关测试通过**

Run: `npx vitest run tests/product-overview.test.ts tests/product-overview-component.test.ts tests/feature-detail.test.ts tests/business-domains.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/business-domains.ts lib/product-overview.ts components/product-overview.tsx lib/ui-strings/product.ts tests/business-domains.test.ts tests/product-overview.test.ts tests/product-overview-component.test.ts tests/feature-detail.test.ts
git commit -m "feat: present business domains in product overview"
```

### Task 3: SalesBuddy 一次性只读迁移规划与 dry-run

**Files:**
- Create: `scripts/salesbuddy-business-domain-migration.ts`
- Create: `tests/salesbuddy-business-domain-migration.test.ts`

**Interfaces:**
- Produces: `planSalesBuddyBusinessDomainMigration(features)`，返回父节点创建计划、子功能移动计划及当前值快照；`runSalesBuddyBusinessDomainMigration({ productSlug, apply, backupDir, restoreFrom? })` 供 Task 4 使用。
- CLI: `npx tsx scripts/salesbuddy-business-domain-migration.ts --product salesbuddy`（dry-run）；只有显式 `--apply` 才可写入。

- [ ] **Step 1: 写失败测试**

- 输出恰好 6 个父节点和 22 个移动计划；23 个未分组功能不变。
- 重复功能 ID、未知 ID、目标父级冲突、已有 `parent_id` 时中止且不写数据库。
- 报告记录每个子功能原 `parent_id`、`source`、核实状态与编辑归因，供回滚使用。

- [ ] **Step 2: 验证测试失败**

Run: `npx vitest run tests/salesbuddy-business-domain-migration.test.ts`
Expected: FAIL，迁移规划函数不存在。

- [ ] **Step 3: 实现映射和只读 dry-run**

映射使用本文件 ID 清单。dry-run 输出父节点、移动、未分组清单和校验错误；不得仅凭名称模糊匹配或自动归类。

- [ ] **Step 4: 验证测试通过并生成报告**

Run: `npx vitest run tests/salesbuddy-business-domain-migration.test.ts`
Expected: PASS。
Run: `npx tsx scripts/salesbuddy-business-domain-migration.ts --product salesbuddy`
Expected: 仅输出计划，无数据库写入。

- [ ] **Step 5: Commit**

```bash
git add scripts/salesbuddy-business-domain-migration.ts tests/salesbuddy-business-domain-migration.test.ts docs/superpowers/plans/2026-11-17-salesbuddy-business-domains.md
git commit -m "feat: add salesbuddy business domain migration plan"
```

### Task 4: 事务写入、备份与回滚

**Files:**
- Modify: `scripts/salesbuddy-business-domain-migration.ts`
- Modify: `tests/salesbuddy-business-domain-migration.test.ts`

**Interfaces:**
- Consumes: Task 3 的迁移计划与 CLI。
- Produces: `artifacts/business-domain-backups/salesbuddy-<UTC timestamp>.json`（本地生成，不提交）；`--restore <backup.json> --apply` 回滚路径。

- [ ] **Step 1: 写失败测试**

- 单事务创建父节点并移动子功能；任何一步失败均 rollback。
- 验证更新 SQL 只改变 `parent_id` 和新父节点字段，不改子功能 source、核实状态、编辑归因或场景。
- 写入前备份完整原值；回滚恢复原 `parent_id` 并软下线新父节点。
- 备份缺失、产品不匹配、当前父子关系已漂移时拒绝写入。

- [ ] **Step 2: 验证测试失败**

Run: `npx vitest run tests/salesbuddy-business-domain-migration.test.ts`
Expected: FAIL，事务、备份与回滚尚未实现。

- [ ] **Step 3: 实现安全写入与回滚**

使用 `getConnection()`、`beginTransaction()`、`commit()`、`rollback()`、`release()`。备份在事务外写入本地 JSON；回滚要求显式 `--apply` 和匹配备份，不硬删除任何功能。

- [ ] **Step 4: 验证测试通过**

Run: `npx vitest run tests/salesbuddy-business-domain-migration.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/salesbuddy-business-domain-migration.ts tests/salesbuddy-business-domain-migration.test.ts
git commit -m "feat: make business domain migration reversible"
```

### Task 5: 全量验证、生产迁移与业务验收

**Files:**
- Modify only issues found by verification; no planned feature files.

**Interfaces:**
- Consumes: Tasks 1–4 的全部代码和迁移脚本。
- Produces: 可核对的 SalesBuddy 业务首页、迁移报告、回滚备份和发布数据核对记录。

- [ ] **Step 1: 全量验证与独立审查**

Run: `npm run typecheck && npm test && npm run build`
Expected: 全部通过。独立审查身份保持、未分组回退、问答检索、迁移漂移和回滚语义；Critical/Important 问题先补失败测试再修复。

- [ ] **Step 2: 部署代码但不改业务数据**

使用现有 Docker 流程构建并部署，确认 migration 077 已存在且冒烟通过。此步骤只发布读取层。

- [ ] **Step 3: 生产 dry-run 与人工审阅**

Run: `npx tsx scripts/salesbuddy-business-domain-migration.ts --product salesbuddy`
核对 6 个父节点、22 个移动、23 个未分组功能及全部冲突检查。未获明确批准前不得加 `--apply`。

- [ ] **Step 4: 备份后执行迁移并验证**

经人工批准后执行 `--apply`，保存备份路径。验证：
- 原有 45 个功能仍保持 active，新增 6 个父节点后共 51 个 active 节点；场景与发布历史数量不变。
- 22 个子功能仅 `parent_id` 改变，其他字段不变。
- 6 个父节点为 manual、未核实，无重复父节点，且不进入普通「需要确认」列表。
- 首页仅显示 6 个业务卡片；完整规格包含全部 45 个原功能及 6 个父节点。

- [ ] **Step 5: 真实业务验收**

检查桌面与窄屏，确认用户能从「沟通 → 客户认知 → 承诺 → 销售执行/团队管理」下钻到原始场景和证据。验证「管理者如何发现逾期承诺」时，证据不足处必须显示未知而非补写流程。

- [ ] **Step 6: 发布数据核对与回滚准备**

读取新 release 和 `spec_changes`，区分代码展示变化与人工分组变化。CoDelphi MCP 不可用时不得声称完成 MCP 对账。保留 dry-run、备份和回滚命令；只有用户另行批准才可执行回滚。

- [ ] **Step 7: 最终提交与清理**

提交所有代码和测试，清理 worktree 与临时构建目录。备份文件保留在受控本地产物目录，不提交、不公开客户数据。

## 非本轮事项

- 纯版本号变化导致回归推荐噪声：另立确定性过滤任务，不与业务分组混合。
- 业务对象关系图、AI 质量评分、五类角色首页、项目上下文 Agent 交接、完整 QA 生命周期：均不进入本轮。
