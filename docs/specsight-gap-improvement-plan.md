# CoDelphi 改进计划：补齐分发层与覆盖披露

> 日期：2026-11-09
> 来源：specsight.app 竞品调研 + CoDelphi 代码库只读调研
> 基线：`product-capability-maturity-roadmap.md` v1（2026-11-08 冻结）、`product-roadmap.md` M1–M13、`first-analysis-coverage-2026-11-08.md`、`pilot-blind-eval-superset-2026-11-08.md`
> 状态：待评审。**本文件不修改基线文档**；能力实际落地后，按基线文档「使用约定」做一次能力对账再更新基线元数据。
> 与既有文档的分工：本文件只排工序、依赖与验收闸门；**能力状态以 `product-capability-maturity-roadmap.md` 为准，里程碑定义以 `product-roadmap.md` 为准**。三处冲突时，以代码 + 基线文档为准。
> 工期口径：只给批次顺序与放行闸门，不承诺日历工期；规模沿用 S / M / L，由负责人排期。
> 修订记录：2026-11-09 初稿（用户确认「分片多趟已在做」，其余对比结论采纳）；同日 v1.1（用户裁决「目标是完整规格，是否增量不是要考虑的条件」，增量路径多趟纳入 W0-6；另两项开放问题补上争议背景与裁决选项）；同日 v1.2（用户质疑「多个仓库各自出规格还算同一个产品吗」，复核数据模型后勘误 §6.2，C2 收缩为接入层，多仓库单一规格与跨仓影响面合并为独立立项）；同日 v1.3（用户追问「只做检索不生成答案是不是只有问题没有答案」，澄清检索式问答的输出形态，按 `lib/spec-search.ts` 实际实现修正 C 方案并拆为 B2.1 / B2.2 两阶段）。

---

## 0. 结论与边界

**一句话**：CoDelphi 在「规格可信度链路」上已经强于 Specsight，差距只剩两处——**读得窄**和**送得近**。前者由在建的「分片多趟提取」解决，本计划主攻后者，并为前者定义收口验收。

判断依据（对比结论，不重复展开）：

| | Specsight | CoDelphi |
|---|---|---|
| 读代码 | Claude Agent SDK 两遍遍历全库（先建图再逐 feature 深挖） | 单次 LLM + 160KB 切片；多趟提取在建 |
| 防幻觉 | 第二遍 LLM 复核 + 自动质检，无公开实测数字 | `assertEvidence` 越界引用即失败、确定性 `diffSpec`、第三方盲评与覆盖率量化 |
| 人工回路 | 可编辑、可批注 | manual 红线 + 漂移 + 绑定双版本的核实生命周期 + 四态回归任务 |
| 分发 | 每周 Digest、客户向 Release notes、Ask、**MCP 17 工具** | 通知、导出、PR 预演；**Digest / Release notes / MCP 均未实现** |

**两条独立证据收敛到同一结论**：Specsight 创始人在 Vestbee 访谈中说，早期流失客户「不想再多一个 dashboard，更愿意在 email、Slack、AI 助手里拿到信息」，因此转向 MCP 与邮件；`docs/user-personas.md:111` 独立得出「瓶颈不在功能而在触达」。CoDelphi 已经做对了 PR / 通知这一半，缺的是**把知识包装成别人愿意读的内容**那一半。

### 本计划的红线（不因为对标而让步）

1. **不学 Specsight 的话术**。它对全公司卖「产品的唯一真相」，但没有公开准确率实测；CoDelphi 已有盲评和覆盖率量化，应把它做成卖点而非藏起来。继续沿用 `CoDelphi-评审回路收敛与下一步.md` §2 的话术收敛与禁用词。
2. **不放弃证据链接、确定性 diff、人工审核门禁**。所有新增分发能力必须继承这套机制，详见 §9 风险 R1。
3. **不引入 Agent SDK 绕过 `assertEvidence`**；借鉴的是「两遍 / 分片」思路，不是替换校验。
4. **不换数据库、不加 Redis、不新增账号体系**（`AGENTS.md` 红线 + `product-roadmap.md` §5 非目标）。
5. 沿用 `product-roadmap.md` §5 全部非目标，尤其**不做架构图**、**不做 IDE 内聊天 UI**。
6. **规格完整性不因运行模式降级**：目标是完整规格，「首分析 / 增量 / RC2-carry」只是投入方式，不是降低覆盖的理由。任何模式下实现面超出单窗都必须分片多趟；覆盖率口径与验收门槛全模式统一（用户裁决，2026-11-09）。

---

## 1. 现状对账（本计划的范围边界）

| 能力 | 状态 | 证据 |
|---|---|---|
| 分片多趟提取（全量路径） | **进行中**（工作区未提交） | `lib/analysis.ts:316-343`、`lib/remote-analysis.ts:139-179`、`lib/extraction-merge.ts`、`lib/env.ts:47-51`、`lib/ai.ts:196` |
| 增量 / RC2-carry 路径覆盖 | **待改（已裁决）** | `lib/analysis.ts:311-313` 明写「保持单窗」，`:344-358` 走 `getRemoteAnalysisSources` 单次调用；纳入 W0-6 |
| 覆盖披露 | 待办 | `first-analysis-coverage-2026-11-08.md:43` 仍列为第 ③ 步未落地；规格页与导出无覆盖率 |
| MCP server（M10） | 待办 | `product-capability-maturity-roadmap.md:69` 标未实现；`product-roadmap.md:151-155` 有初版规划 |
| Digest / Release notes / 分享页（M11 扩展） | 待办 | `product-capability-maturity-roadmap.md:70`「可信 changelog / 分享页完整形态」未实现；`product-roadmap.md:157-161` 有初版规划 |
| Highlight 分类 | 待办 | `spec_changes` 无类型列（`migrations/002_spec_versions.sql`） |
| 站内 Ask over spec | **待产品决策** | `product-roadmap.md:198` 明列「不做 IDE 内聊天 UI」；站内问答是否属于该非目标需先裁决，见 §5.2 |
| 多 provider / 多仓库（M12） | 部分 | `lib/code-hosting/registry.ts` 只注册 github；一产品一主仓库、**一份规格版本链**（`README.md:105`、`migrations/002_spec_versions.sql:4`）；多仓库单一规格与跨仓影响面需单独立项，见 §6.2 |
| 定价页 / 数据处理条款 / DPA | 待办 | `CoDelphi-评审回路收敛与下一步.md:59-68` 列为 P0；`app/pricing/page.tsx:16` 价格占位 |

> 注意：上表「进行中」指当前工作区代码，尚未提交、尚未进基线文档。本计划把它当**前置依赖 W0**处理，不重复设计、不重复排期。

---

## 2. 优先级总表

| 编号 | 事项 | 批次 | 依赖 | 规模 | 放行闸门 |
|---|---|---|---|---|---|
| W0 | 分片多趟收口与复测（含增量路径统一） | 在建 | 无 | M–L | 五仓库覆盖率复测 + **增量模式** superset 召回 ≥80% + 两层集合等价常驻回归 + 增量路径多趟生效 |
| A1 | MCP server（M10 扩展） | A | 无 | M–L | Claude Code / Claude / ChatGPT 可连；工具只读、越权不泄露；返回项带证据链接 |
| A3 | Highlight 九类分类 | A | 无 | S | 安全 / 权限 / 定价类变化能正确打标；大多数 release 允许无 Highlight |
| A2 | Digest + Release notes + 公开页 | A | A3 | L | 人工审核前不可发布；每条宣布项可回溯到 `spec_changes` 与证据链接 |
| C1 | 定价页 + 数据处理条款 + DPA | C | 无 | S | 四类条款公开可读；与现有账务设计一致 |
| B1 | 覆盖披露 | B | W0 | M | 页面数字与 `measure-first-analysis.ts` 口径一致；触顶显式提示 |
| B2 | 站内 Ask over spec（B2.1 检索式 / B2.2 生成式） | B | W0 + 产品决策 | M | 答案可回溯到规格条目与 evidence 链接；spec 未覆盖时明确拒答（B2.1 为返回无结果、B2.2 为拒答）而非猜测 |
| B3 | feature 连接图 | B | W0 | M | 只做功能关系，不复活架构图 |
| C2 | 多 provider（**仅接入层**） | C | 无 | L | GitLab 或 Gitea 一家跑通完整分析链路；产品粒度与规格份数不变 |

**为什么 A1 排第一**：MCP 只读取**已经生成并已过 `assertEvidence` 的结构化数据**，不新增 AI 生成文本，因此不引入新的幻觉面；而 A2 的 Digest / Release notes 是新的自由文本生成，风险更高（§9 R1）。先做低风险、高杠杆的出口，再补需要门禁的内容层。

**批次内可并行关系**：A1 与 A3 可并行；A2 依赖 A3（用 Highlight 排序与选取宣布项）。B1 是 B2/B3 的前置（覆盖口径先定义，问答与地图才能正确声明边界）。C1 与所有工程批次并行，但**优先级实际最高**——已经收钱，条款缺失是首次采购会谈的终止项。

---

## 3. W0｜在建项：分片多趟的收口（不重复建设）

### 3.1 现有实现概要（供评审对齐，不是待办）

- 分区规划：`lib/remote-analysis.ts:139-179` `getPartitionedAnalysisSources`，同一索引反复规划，每趟 `excludePaths` 排除已选路径；单窗仓库恰好返回 1 个分区，行为与旧路径一致。
- 提取与合并：`lib/analysis.ts:302-332` 逐趟 `analyzeWithAI` + 每趟独立 `assertEvidence`，`lib/extraction-merge.ts` 做**确定性**合并（stable key 分组、行为等价去重、引用冲突重编号、changes 去重截断 150）。
- 趟数上限：`lib/env.ts:47-51` `ANALYSIS_MAX_PARTITIONS`，默认 6，触顶即停。
- 成本：`llm_call_receipts` 同 `runId` 多行如实记账（契约 M0-T2）；SAU 结算仍每 run 一次。

### 3.2 必须补齐的五个收口项

| # | 收口项 | 具体要求 | 验收 |
|---|---|---|---|
| W0-1 | 五仓库覆盖率复测 | 用 `scripts/measure-first-analysis.ts` 同口径重跑 express / zod / flask / hono / cal.com | 记录修复后 vs 多趟后两组数字；重点看 zod（1.4%）、cal.com（0.1%）是否脱离个位数 |
| W0-2 | 第三方盲评重跑 | 按 `pilot-acceptance-template.md` 口径重跑 `apache/superset` 同一窗口，**判定人与预标冻结件沿用或重新独立冻结** | 召回率从 46.7% 提升到 ≥80%（门槛）；精确率不得回退到 31.6% 量级；8 条未命中中因窗口缺失的 5 条应被覆盖 |
| W0-3 | 两层集合等价常驻回归 | `demo-improvement-plan.md:73` 要求把「版本层 features == 工作台 active features」固化为常驻测试 | 新增测试覆盖多趟合并路径，M9 交接文档 I1 的缺陷不得在多趟下复现 |
| W0-4 | 合并层边界测试 | `mergeChunkResults` 的 changes 截断 150、功能摘要「场景多者胜出」、`nextReference` 重编号 | 有单元测试；截断发生时日志可查，不静默丢弃 |
| W0-5 | 成本与配额复核 | 6 趟 × 单次调用，确认 `billing_quota_wallets` 预留、`llm_call_receipts` 多行、SAU 结算三者一致；与定价页（C1）同步口径 | 一次多趟 run 的账单可完整对账，无重复计费、无漏记 |
| W0-6 | 增量 / RC2-carry 路径统一多趟 | 见 §3.3 裁决与六个实施要点；`affectedKeys !== null` 分支不得再走单窗 | 增量模式重跑 superset 窗口，召回与全量同门槛；carry-forward 语义与 M9 影子对比不回归 |

### 3.3 已裁决：增量路径与全量路径同一覆盖目标

**裁决（用户，2026-11-09）**：「目标是完整规格，是否增量不是要考虑的条件。」即规格完整性是产品承诺，全量 / 增量 / RC2-carry 只是成本与时序的实现手段，不构成降低覆盖的理由。因此 `lib/analysis.ts:311-313` 注释中「增量与 RC2-carry 路径保持单窗」的设计决策作废，纳入 W0-6。

**为什么这条裁决是 W0 的放行前提**：`pilot-blind-eval-superset-2026-11-08.md:12` 记录盲评运行方式是「签名 webhook 驱动真实 push 管线，**增量模式 carry-forward**」。当前多趟只改了首分析，而用来验收召回的那场盲评恰好走单窗增量路径——若不动增量，W0-2 重跑的召回数字不会提升，W0 会被自己的验收挡住。

**实施要点（W0-6 的设计边界，不改架构红线）**：

1. `affectedKeys !== null` 分支同样走 `getPartitionedAnalysisSources`，**按实现面而非运行模式**决定是否分片；单窗仓库仍返回 1 个分区，行为与旧路径一致。
2. 每趟独立 `assertEvidence`，allowSet 须包含 `change.files`（diff 文件）与该分区 slice 文件，防止多趟下引用越界扩散。
3. `affectedFeatureNames` / `previousSpecText` 逐趟透传，`knownFeatureNames` 跨趟累积；合并复用 `mergeChunkResults`，不新建合并逻辑。
4. `saveResult(run, result, change, affectedKeys)` 的 `affectedKeys` 语义（carry-forward 沿用未受影响功能）不得因多趟改变；用测试锁定「未受影响功能保持上一版措辞」。
5. `lib/analysis.ts:394-399` 的 M9 影子对比读 `singleWindowSources`；增量多趟后需明确其输入（建议保持单窗对照，或显式记录「影子对比仅覆盖单窗」），不得静默失效。
6. 成本同按 `llm_call_receipts` 多行记账、SAU 每 run 一次；增量与全量共用 `ANALYSIS_MAX_PARTITIONS` 上限。

**验收口径统一**：W0-2 在增量模式下重跑，召回 ≥80% 与精确率不回退两条门槛与首分析一致；B1 的覆盖率只按「本规格版本对应的完整实现面」一个口径计算，run 类型仅作诊断元数据记录，**不得作为放宽门槛或解释缺口的理由**。

> **W0-2 未达标前，不进入 B2 / B3**；B1 覆盖披露可先行，但必须在产物上标注「分片多趟验收未达标」。批次 A 与 C1 不受 W0 阻塞，可立即启动。

---

## 4. 批次 A｜把已有知识送出去

### 4.1 A1 · MCP server（M10 扩展）

**对既有决策的修订**：`product-roadmap.md:151-155` 定为「独立 stdio 进程 + 直连 MySQL + 4 个只读工具」。本计划保留「独立进程、直连 MySQL、不造 IDE 聊天 UI」，但**传输形态改为 Streamable HTTP + OAuth（PKCE）为主、stdio 为本地可选**。理由：Specsight 的留存经验表明价值在「AI 助手里直接拿到答案」，stdio 只能覆盖本机 IDE，覆盖不到 Claude / ChatGPT 网页端与团队内非工程师。

**工具面**：从 M10 的 4 个扩展到对标 Specsight 的 15 读 + 1 起草 + 1 反馈，逐条映射到现有数据：

| 工具 | 数据源 | 现状 |
|---|---|---|
| `list_projects` | `products` + `lib/product-access.ts` | 现成 |
| `get_project_summary` | `app/api/products/[slug]/spec.json/route.ts` | 现成 |
| `get_feature` / `get_scenario` | `features` / `scenarios` + `lib/stable-links.ts` | 现成 |
| `search_scenarios` | `lib/spec-search.ts` | 现成 |
| `list_releases` / `get_release` / `get_changelog` | `releases` / `changes` / `spec_changes` | 现成 |
| `get_feature_connections` | `spec_file_index` 反推 | 待写，依赖 B3 可先返回空 |
| `get_annotations` / `get_regression_tasks` | `regression_tasks` + 批注 | 现成（B3 前不承诺连接图） |
| `show_flow` | `lib/feature-flow.ts` / `components/feature-flow.tsx` | 现成 |
| `get_release_notes` / `get_digests` | A2 新建表 | **依赖 A2** |
| `draft_release_notes` | A2 + 角色校验 | **依赖 A2**，仅 editor/owner，且只起草不发布 |
| `send_feedback` | `lib/feedback.ts` | 现成 |

**认证与隔离**：

- 沿用 `lib/product-access.ts` 的 `viewer < editor < owner` 三级；组织成员 + 产品成员双通道，越权返回空结果而非报错。
- API key：仅存 SHA-256 哈希 + 前缀（建议 `sk_cd_`）+ 前 8 位可识别片段，组织级 scope，软撤销保留审计（`revoke_at` 时间戳），成员离职即失效；**API key 只读**。
- OAuth PKCE：token 仅存哈希，1 小时续期，30 天未使用需重连；批准页展示应用名与回跳地址。
- 限流复用 `lib/rate-limit.ts`，建议 100 req/min per connection；搜索结果上限 50。

**验收**：

1. Claude Code 一条命令连上，Claude / ChatGPT 网页端经 OAuth 连上，三条「预置请求」可用：`Tour of my product`、`What shipped this week`、`Explain a feature`。
2. 每个返回项带 stable link 与 evidence URL（可点击到源码行）——这是相对 Specsight 的差异化，不得省略。
3. 工具集**不能**创建项目、编辑场景、邀请成员、改账单、发布 release notes；集成测试覆盖越权与只读约束。
4. 有 MCP 协议层集成测试与限流测试；`npm run typecheck && npm test && npm run build` 通过。

### 4.2 A3 · Highlight 九类分类（A2 的前置供料）

在 `spec_changes`（或新建 `spec_change_highlights`）上加 `highlight_type` 枚举与 `highlight_reason`：

`Heads-up` / `Pricing` / `Limits` / `Privacy` / `Security` / `Access` / `Integrations` / `Beta` / `News`

- 判定用一次便宜的分类调用或确定性规则（文件名 / 证据路径 / change.kind），**成本走 `llm_call_receipts` 记账**；绝大多数 release 无 Highlight，不要为了填满而强标。
- 展示位：Changes 列表、release 页、Overview 卡片、通知邮件、A2 的 Digest/Release notes 选取页、A1 的 changelog 工具返回值。
- **验收**：用 superset 盲评窗口的安全权限收紧、feature flag 相关变化做样本，检查 `Security` / `Access` / `Beta` 能否正确打标；`Beta` 只是标注，**不得宣称已能识别灰度开关**（静态分析盲区，见 §9 R3）。

### 4.3 A2 · Digest + Release notes + 公开页（M11 扩展）

**复用**：`lib/notifications.ts`（Slack / webhook / email）、`migrations/021_notification_channels.sql`、`023_user_email_prefs.sql`、`changes` / `spec_changes` / `releases`、`components/behavior-change-item.tsx` 的前后对比、`lib/public-demo.ts` 的匿名只读、`lib/spec-search.ts`。

**建议新增**：`digests`、`release_notes`、`voices`、`release_note_blocks`（块级草稿）、`highlights`（若不加列）、`share_tokens`（沿用 M11 的按 release token 设计）。

**Digest（内部）**：

- 每周定时生成，不引 Redis——复用 `instrumentation.ts` 的 `GET_LOCK` sweep 模式；每项目独立排期，同一时间/时区的多项目合并一封邮件。
- 内容结构：本期变了什么 → 对 support / sales / marketing 分别意味着什么 → 关键变更可点开看前后差异与证据。**无变化不发**（沿用现有通知规则）。
- 导出 PDF / Markdown；状态沿用 `explainer_cache` 的 pending / generating / ready / failed 语义。

**Release notes（客户向）**：

1. 选日期范围 → 勾选要宣布的变更（默认按 A3 的 Highlight 排序，但不自动全选）→ 填「重点强调」→ 选 voice → 生成草稿。
2. voice 字段：`name` / `audience` / `tone` / `structure` / `house_rules` / `language`，每项目最多 3 个；无 voice 时沿用产品既有语气。
3. 草稿块级编辑 + Enhance 单块改写；**每个块必须锚定到至少一个 `spec_changes.id`，并携带 evidence 链接**（§9 R1 的核心门禁）。
4. **人工点击 Publish 才发布**；发布到公开只读页（无需登录），可 Copy as Markdown / email-safe HTML / 纯文本；Unpublish 后同 URL 下线；已发布只读，需下线才能改。
5. 隐私边界沿用 M11：公开页展示行为变化与证据**路径**，代码内容仍需仓库权限，页面明确说明「链接对无权限者不可达」。

**验收**：

- 从一条真实 release 走完：勾选 → 草稿 → 编辑 → 发布 → 匿名访问公开页 → 证据链接可达。
- 未人工确认不能发布；草稿中存在指向不存在 `spec_change` 或越界 evidence 路径的块时，生成阶段即失败（类似 `assertEvidence` 的引用存在性校验）。
- Digest 在无变化的周不发送；邮件退订 / 偏好沿用 `user_email_prefs`。
- 记录「人工修正条数」作为验收指标（`pilot-acceptance-template.md:24`），防止「省时来自没人细看」。

---

## 5. 批次 B｜依赖 W0 的能力

### 5.1 B1 · 覆盖披露（W0 的直接产物，优先级最高）

**口径**沿用 `scripts/measure-first-analysis.ts`：

- 实现面 = `evidenceKind` 分级的 implementation 文件；代码口径 = 其中的源码扩展名。
- 披露四项：本次装配的实现文件数 / 全仓实现文件数、字节数 / 全仓字节数、覆盖率 P%、**趟数与是否触顶**（`ANALYSIS_MAX_PARTITIONS`）。
- 覆盖率只有一个口径：本规格版本对应的完整实现面；run 类型（首分析 / 增量 / RC2-carry）仅作诊断元数据，不另设门槛，也不得用来解释未覆盖部分（§3.3 裁决）。

**落库**：`analysis_runs` 增字段或新建 `analysis_coverage_receipts`，与 `spec_versions` 关联；append-only，历史版本能查回当时的覆盖率。

**展示位**：规格页头部、`spec.json`、所有导出（Gherkin / Markdown / 回归清单 / 进展摘要 / Explainer）、A1 的 `get_project_summary`、A2 的 Digest/Release notes 页脚。

**措辞红线**：只写「证据覆盖率」，禁用「可信度 / 正确性 / 真相源」（`CoDelphi-评审回路收敛与下一步.md:47-51`）；触顶时必须显式写「本规格未覆盖全部实现面，未覆盖部分不产生结论」。

**验收**：五仓库各跑一次，页面/导出数字与测量脚本一致；`ANALYSIS_MAX_PARTITIONS` 触顶的仓库有显式警示；历史版本覆盖率可回溯。

### 5.2 B2 · 站内 Ask over spec（待裁决：与非目标的边界）

**争议点是什么**：`product-roadmap.md:198` 的非目标原文是「**不做 IDE 内聊天 UI**：走 M10 MCP，让开发者的 agent 来问」。本计划提议的 B2 是在 CoDelphi **站内规格页**做一个问答入口，让销售 / 客服用自然语言问「这个功能现在怎么工作」——字面上它不在「IDE 内」，但它确实是一个自建的问答界面（A 方案还会生成自由文本答案）；非目标后半句「让开发者的 agent 来问」也可解读为「自有问答 UI 一律不做，交给 MCP」。所以本计划不能自行判定，需产品明确：这条非目标约束的是**形态（IDE 插件）**还是**能力（自建问答界面）**。

| 裁决 | 做法 | 代价 |
|---|---|---|
| A 不冲突 | B2 可做；落地后按基线文档「使用约定」把非目标措辞收窄为「不做 IDE 内聊天 UI / 不做通用 AI 助手 UI」，B2 限定为规格范围内问答 | 需改基线文档（本计划不改） |
| B 冲突 | 砍掉 B2 站内 UI，只保留 A1 MCP，让 Claude / ChatGPT 当问答界面 | 非技术角色必须会用外部 AI 助手，Specsight 的 Ask 触达优势补不上 |
| C 折中（建议作为第一阶段探针） | **检索式问答**：用户用自然语言提问，系统返回命中的规格原文条目（feature / scenario 的 C/A/O + 证据链接）作为答案，**不新写任何给用户看的文字** | 没有摘要式答案、不能跨条目综合；但零新幻觉面、不触碰非目标、可先验证需求 |

#### 「不生成答案」是什么意思：答案 = 规格原文，不是模型新写的一段话

以「上传文件最多几个？单个文件最大多大？」为例，三种方案的**输出**区别：

| 方案 | 用户看到的东西 |
|---|---|
| A 生成式（对齐 Specsight Ask） | 「目前一个请求最多上传 10 个文件，单个不超过 20MB……[1][2]」——LLM 基于命中条目**新写**的一段话，带编号引用 |
| B 仅 MCP | 在 Claude / ChatGPT 里问，答案由外部助手生成 |
| C 检索式 | 没有这句总结，直接列出命中的规格条目卡片：`文件上传 · HP-1` + `Context / Action / Outcome` **原文** + `src/upload.ts:42` 证据链接 + 打开功能页。答案就是规格里已经写好、已过 `assertEvidence` 的原文，系统只负责找出来并原样呈现 |
| 无命中（三方案共同） | 明确写「当前规格未覆盖此问题」+ 未覆盖声明，不得用通用知识补全 |

所以 C **有答案**，只是答案不由模型生成；它是「能听懂问句的搜索」，不是「只有问题没有答案」。代码依据：`lib/spec-search.ts:13-31` `searchSpec` 返回 features / scenarios 原文，`components/spec-search.tsx:73-82` 已把命中渲染成 `context → action → outcome` 卡片并跳转功能页。

**按代码复核后需修正 C 的两点（v1.3）**：

1. `searchSpec` 是 `LIKE '%query%'` 纯子串匹配（`lib/spec-search.ts:8-30`），整句问句丢进去几乎必然零命中。C 若要「听懂自然语言」，必须补一层**查询理解**（问句 → 关键词 / 同义词 / 实体，规则或一次便宜的改写调用）；这次调用只产出**检索词**、不产出给用户看的文字，因此幻觉面仍为零。
2. `SpecSearchResult` 当前不含 evidence 路径与 stable link（`lib/spec-search.ts:3-6`），且匿名 demo 下搜索接口会跳登录（`demo-four-roles-walkthrough.md:41`）。C 要满足「每条附证据链接 / 无命中明确说未覆盖」，需补返回字段并修匿名可用性。

#### 分两阶段：C 不是终局

- **B2.1 = C**：问句 → 查询改写 → 原文条目卡片 + 无命中明确返回无结果。零生成文本、不碰非目标；用真实使用数据验证「到底有没有人问、问什么、命中率多少」。
- **B2.2 = A**：若 B2.1 证明需求真实，再加带编号引用 + 引用存在性校验 + 拒答门禁的**生成式摘要**，并继承 §9 R1 的内容块锚定规则。这才对齐 Specsight 的 Ask，能给销售 / 客服一段可直接转发的话。

**裁决提示**：若目标就是「让非技术角色拿到一段能直接读、能转发的话」，C 不够，应直接选 A 并接受 R1 门禁；C 的价值是低成本探针，不能替代 Ask。

#### 两阶段共同的实现约束

- 检索用现成 `lib/spec-search.ts`，**不引入向量库 / RAG 基础设施**（非目标）。
- 答案（原文卡片或生成摘要）每条可点击到 feature / scenario / release，附 evidence 行号链接。
- **spec 未覆盖时明确拒答**，不得用通用知识补全；问答线程私有、可导出 / 删除；对话留存与删除策略须写进 C1 的数据处理条款。
- 规模 M；验收用 20 个预设问题，其中至少 5 个故意超出 spec 范围：B2.1 检查「明确返回无结果」100%，B2.2 另加引用存在性与拒答率 100%。

### 5.3 B3 · feature 连接图（可延后）

- 先用 `lib/spec-file-index.ts` 的共享证据文件关系**确定性**推断 `Shares data` / `Depends on`，再让 LLM 补 `Leads to` / `Triggers`；每条连接标注依据是「共享文件」还是「模型推断」。
- 只做功能之间的关系，**不复活已下线的系统架构图**（`README.md:40`、`architecture-facts.md`，非目标）。
- 验收：连接可点开看依据；推断类连接占比与人工抽查错误率一并记录，不宣称完整调用图。

---

## 6. 批次 C｜商业契约与结构扩展（与工程并行）

### 6.1 C1 · 定价页 + 数据处理条款（零工程依赖，实际最紧急）

`CoDelphi-评审回路收敛与下一步.md:59-68` 已列为 P0，本计划不新增论证，只列交付清单：

1. **子处理方名单**：LLM 网关及其上游、数据库、邮件、支付；标注各自数据驻留区域。
2. **源码处理条款**：是否用于训练、留存时长、删除与撤回机制、代码出域路径；对齐 `README.md:179-188` 的数据边界，但把免责声明升级为条款。
3. **事故通知时限与责任上限**；DPA 可应请求提供。
4. **`/pricing` 上线**（当前 `app/pricing/page.tsx:16` 为占位、`components/pricing-panel.tsx:105` 暂不开放购买），与 `codelphi-pricing-and-billing.md` 现有账务设计对齐，**不重写计费**；7 天试用 / 14 天退款 / 90 天数据保留的对外表述同步。
5. 若 B2 落地，补充「问答对话留存与删除」条款。

> 验收：四类条款有公开可读页面；与 `lib/billing/*` 实际行为一致；定价页可访问且不含占位数字。

### 6.2 C2 · 多 provider（仅接入层，M12）

- `lib/code-hosting/registry.ts` 目前只注册 github；按需求拉动，一次一家，以 `github-provider.ts` 为范本补齐 webhook 验签差异；`migrations/012`/`013` 已预留。
- **C2 的范围只到接入层**：不改变「一个产品 = 一个主仓库 = 一条规格版本链」的产品粒度，验收即「GitLab 或 Gitea 一家跑通完整分析链路」。

#### 勘误（v1.2，2026-11-09）：「一产品多 repo、各自出规格」不成立

初稿把第二层写成「多个仓库挂到同一产品、各自出规格，属产品模型改造」。用户质疑「那还能算同一个产品吗」后复核数据模型，结论是**不能**——各自出规格时产品已退化成聚合标签。CoDelphi 的「产品」不是文件夹，而是一条不可变的规格版本链：

| 约束 | 证据 |
|---|---|
| 一条规格版本链只属一个仓库 | `migrations/002_spec_versions.sql:4,9,12` `repository_id NOT NULL` + FK |
| 一次发布绑定单仓单 SHA | `migrations/001_initial.sql:57` `UNIQUE (repository_id, sha)`；`:33` `analysis_runs.repository_id NOT NULL` |
| 核实生命周期绑定单个 commit | `migrations/028_spec_verification.sql:21` `commit_sha` 单值 |
| 影响面索引按单仓重建 / 查询 | `migrations/017_spec_file_index.sql:3,8`、`lib/spec-file-index.ts:36,58,93`（按 `repository_id` 全删重建、`WHERE repository_id = ?`） |
| 回归任务以单条版本链为范围 | `product-capability-maturity-roadmap.md:96` `(release_id, scenario_id)` 唯一 |

因此「各自出规格」= N 条版本链 + N 组 release + N 套回归任务，真正的产品单元是仓库。这正是 `README.md:105` 已有的「polyrepo 产品可按服务各建产品空间，工作区总览聚合发布动态」——**该形态已存在，不是待做项**；且同段明写跨仓影响传播暂不支持。把它写进 C2 既重复建设，也不解决 `CoDelphi-评审回路收敛与下一步.md:98` 的 P1 问题。

#### 修正后的三层

1. **多 provider**：代码从哪拉（GitHub / GitLab / Gitea）——接入层，C2 唯一范围。
2. **多仓库证据池，单一规格**：一个产品仍产出**一份**规格，多个仓库只是证据来源集合（Specsight 的 project ↔ 多 repo 也是这个关系）。这既是能力升级，也是跨仓影响面的前提：只有所有场景落在同一条版本链、同一张规格里，「A 仓契约变更 → B 仓哪些场景受影响」才有计算对象。要改的是**证据层 / 索引层，不是产品层**：
   - 证据引用加 `(repo, path)` 命名空间，否则同名 `src/api.ts` 冲突、`assertEvidence` 的 allowSet 误判；
   - 版本链绑定**各仓 HEAD 组成的 commit vector** 而非单 SHA，`spec_verification.commit_sha`、stable link、计费回执随之调整；
   - `spec_file_index` 已有 `(repository_id, path)` 复合键，但重建按单仓全删、查询按单仓过滤，需改为产品级；
   - webhook 按产品聚合，或按仓 run 合并进同一版本链；PR 预演 / check run 天然属单仓，需定义多仓下的呈现。
   - **与 W0-6 的接点**：`getPartitionedAnalysisSources` 本就是「按实现面分片」，分片来源可来自不同仓库并合并进同一 spec version（复用 `mergeChunkResults`）。多仓库更应落在这一层，而不是拆出多份规格；这也与 §0 红线 6「目标是完整规格」一致。
3. **跨仓影响面**：建立在第 2 层之上的推理能力，产物是可追溯的受影响场景与回归任务推荐（理由记录符合 `product-capability-maturity-roadmap.md:97` 的多理由数据结构），**不宣称完整调用图**。

#### 由此，上一轮的开放问题有了答案

第 2、3 层**必须合并单独立项**（一起设计、一起验收），不能拆开，也不能继续挂在 C2 的「以后再评」上。`CoDelphi-评审回路收敛与下一步.md:98` 判定单仓限制「封死回归辅助的能力天花板」，而 `README.md:105` 与 `pilot-acceptance-template.md:47` 仍把跨仓影响传播列为不在交付范围——若只做「各自出规格」的聚合形态，跨仓推理只是把边界从产品内挪到产品间，等于没解决。立项时机排在 W0 与批次 A 之后；近期有微服务客户则提前。本计划不为其排期，只保留 §8 非目标中的边界声明。

---

## 7. 验收与退出条件

### 7.1 沿用既有试点口径

`pilot-acceptance-template.md` 三条指标（精确率误报 <10%、召回 ≥80%、发布说明工时下降 ≥30% 且记录人工修正条数）继续有效，且**必须在非作者仓库、由不参与开发的判定人、独立冻结预标**下执行（`CoDelphi-评审回路收敛与下一步.md:74-87`）。W0-2 的重跑必须遵守同一口径、并按 §3.3 在增量模式下执行，否则召回数字不可比。

### 7.2 分发层新增指标

| 批次 | 指标 | 防作弊说明 |
|---|---|---|
| A1 | MCP 工具调用周活、连接后 48h 内复用率 | 只统计成功返回的工具调用 |
| A2 | Digest 打开率、Release notes 发布数、**每条发布稿的人工修正条数** | 修正条数为 0 且耗时大幅下降时，需抽查是否无人细看 |
| A3 | Highlight 命中率（人工抽样 20 条） | 允许「无 Highlight」的 release 占多数 |
| B1 | 披露覆盖率与实际测量偏差 | 偏差 >2pp 视为口径错误，阻断发布 |
| B2 | B2.1 无命中返回无结果比例 / B2.2 超范围拒答率 | 目标 100%；B2.1 另记问句命中率，作为是否升级 B2.2 的依据 |

### 7.3 批次闸门

- **A 闸门**：A1 只读约束 + 证据链接验收通过；A2 人工审核门禁与引用存在性校验通过。未通过不得对外发布任何 Release notes。
- **B 闸门**：W0-2 在**增量模式**下召回 ≥80%（与首分析同门槛）且 W0-3 常驻回归落地；W0-6 增量多趟生效。未通过不得宣称覆盖问题已解决，B1 仍可做但必须标注 W0 未达标。
- **C1 无闸门，立即执行**；已收钱状态下，条款缺失的风险高于任何工程项。

---

## 8. 非目标

沿用 `product-roadmap.md` §5 全部六条（不做架构图、不做 IDE 内聊天 UI、不追公开 OSS wiki 人群、不引入 Redis / 独立队列、不新增账号体系、不用 AI 覆盖 manual），并补充：

1. 不学 Specsight 的「全公司唯一真相源」定位，不用模糊话术掩盖误差。
2. 不为「好读」去掉证据链接、确定性 diff 或人工审核门禁。
3. 不引入 Agent SDK 替换 `assertEvidence`；不引入向量库 / RAG 基础设施。
4. 不换数据库（腾讯云 MySQL 8 红线）、不改为 Serverless 部署（`README.md:177,200` 的 `after()` 约束）。
5. 不做自动化发布、不做「自动生成并执行测试用例 / 测试充分性判定」（基线文档 §「明确不在当前路线中的事项」）。
6. 不在本计划内解决**多仓库单一规格的产品模型改造**与跨仓影响面（两者须合并单独立项，见 §6.2）、独立判据（意图 vs 实现）、SSO / 审计日志 / SLA（列为后续，见 `CoDelphi-评审回路收敛与下一步.md:99-100`）。

---

## 9. 风险与开放问题

| # | 风险 / 问题 | 影响 | 缓解 / 裁决状态 |
|---|---|---|---|
| R1 | **分发层是新的幻觉面**：Digest / Release notes 是 AI 自由文本，不在 `assertEvidence` 保护范围内，且要对外发布 | 高。一条无证据的错误发布稿会直接击穿「可追溯」定位 | 每个内容块强制锚定 `spec_changes.id` + evidence 链接；生成后做引用存在性校验；人工审核后才发布；发布稿保留锚点快照 |
| R2 | **增量路径曾设计为单窗**（`lib/analysis.ts:311-313`），而 superset 盲评跑在增量 carry-forward 模式下 | 高。若不改，W0-2 重跑召回不会提升，W0 会被自己的验收挡住 | **已裁决（2026-11-09）**：完整规格是全模式统一目标，增量不构成降级理由；W0-6 统一多趟，六个实施要点与验收口径见 §3.3 |
| R3 | **Highlight 的 `Beta` 类不等于能识别 feature flag** | 中。静态分析对运行时开关结构性不可见（盲评 §5 已披露） | 文案只说「标注」，不宣称「识别灰度」；公开页与销售物料同步披露盲区 |
| R4 | 多趟使单次 run 的 AI 成本最多 ×6 | 中。影响配额、定价与毛利 | W0-5 账单对账；C1 定价页同步口径；必要时按产品级开关限制趟数 |
| R5 | 公开页泄露证据路径 | 中 | 沿用 M11 隐私边界：只展示路径、不展示代码内容，页面明示「链接需仓库权限」 |
| R6 | 单进程 `after()` 承载 Digest 定时、MCP、通知后压力上升 | 中 | 沿用 `instrumentation.ts` 的 `GET_LOCK` sweep；不引 Redis；若规模证明不足，再按 `product-roadmap.md:193` 演进独立 worker |
| R7 | B2 站内问答可能触碰 `product-roadmap.md:198`「不做 IDE 内聊天 UI」非目标：争议在它约束的是形态还是能力 | 低 | 三选项见 §5.2（A 收窄措辞 / B 只留 MCP / C 检索式问答：答案即规格原文）；C 需补查询理解与 evidence 返回字段，拆 B2.1 / B2.2；裁决前不排期 |
| R8 | 三份外部评审与自家四角色评测输入趋同，「触达是瓶颈」可能是同一把尺子量四次 | 低 | `CoDelphi-评审回路收敛与下一步.md:106-114` 已提示；以第一个付费客户的采购提问与 A1/A2 真实使用数据作为独立验证 |
| R9 | **产品粒度定义歧义**：把「一产品多 repo」做成各自出规格的聚合视图，会重复建设且拿不到跨仓推理能力 | 中。C2 做完仍被误认为已解决 P1 问题 | v1.2 勘误：C2 收缩为接入层；「多仓库证据池 + 单一规格」与「跨仓影响面」合并独立立项，见 §6.2 |

---

## 10. 修订记录

| 日期 | 变更 |
|---|---|
| 2026-11-09 | 初稿。基于 specsight.app 与 CoDelphi 双向调研；用户确认「分片多趟已在做」，故将其列为在建前置 W0 并只定义收口验收；其余对比结论采纳，转为批次 A/B/C 执行计划。 |
| 2026-11-09 | v1.1。用户裁决「目标是完整规格，是否增量不是要考虑的条件」：新增红线 6、W0-6、§3.3 由开放问题改为已裁决（含增量多趟六个实施要点）、W0 闸门与 B 闸门改为增量模式同门槛、B1 覆盖率统一口径、R2 关闭。§5.2 与 §6.2 补上另两个开放问题的争议背景、裁决选项与建议（其中跨仓一项于 v1.2 定案，B2 仍待产品拍板）。 |
| 2026-11-09 | v1.2。用户质疑「多个仓库各自出规格还算同一个产品吗」：按 `002_spec_versions` / `001_initial` / `028_spec_verification` / `017_spec_file_index` 等数据模型复核，确认初稿措辞不成立——各自出规格时产品退化成聚合标签，且该形态 `README.md:105` 已存在。§6.2 勘误并重写三层定义；C2 收缩为仅接入层（§1 / §2 / §8 同步）；「多仓库证据池 + 单一规格」与「跨仓影响面」合并为独立立项，上一轮第三项开放问题由此定案；新增风险 R9。 |
| 2026-11-09 | v1.3。用户追问「只做检索不生成答案是不是只有问题没有答案」：§5.2 澄清 C 为**检索式问答**（答案 = 规格原文条目卡片，非模型新写的文字），补三方案输出对比、具体示例与代码依据；按 `lib/spec-search.ts:8-30` 实际为 `LIKE` 子串匹配、`SpecSearchResult` 不含 evidence / stable link，修正 C 需补查询理解与返回字段；拆为 B2.1 检索式探针 / B2.2 生成式摘要两阶段，并注明「要一段可直接转发的话就得选 A」。§2 闸门、§7.2 指标、R7、§5.2 首段措辞同步。 |
