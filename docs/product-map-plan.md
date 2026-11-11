# 立项：产品行为地图（Product Map）

> 日期：2026-11-11
> 来源：Specsight demo 产品 map 走查（specsight.app demo 空间，2026-11-11）+ 用户裁决「这个 product map 很有用，立项出方案」
> 定位：`docs/specsight-gap-improvement-plan.md` B3 的产品级延伸（下称 B3.2）；**不是新能力，是已有原料的产品级合成**
> 状态：待评审。裁决点见 §8。

---

## 0. 结论与一句话

**一句话**：把已有的功能树、B3 连接、场景计数、完整性账本合成一页产品级行为地图（新一级视图 `view=map`），先在 CoDelphi 自体上 dogfood 验证，再放产线。

三个前提判断：

1. **验证了「不做架构图」红线**：Specsight 最被认可的资产是行为空间的图而非组件依赖图。本立项不画任何模块/调用/部署结构——那是 RepoMap 项目的领地（见 §2）。
2. **缺的是合成不是原料**：Specsight 产品 map 的每个要素我们都已有对应数据（§3 对账表），缺一张产品级一页图。
3. **dogfood 是真实验不是安慰剂**：CoDelphi 仓库含大量 tests / migrations / docs / scripts 非运行时代码，是对「选择质量 + 连接噪声」的真实压力；且可与我们 RepoMap 项目对同一仓库生成的技术架构图并排对照，验证「两图互补不重叠」的定位是否真实成立。

## 1. Specsight 产品 map 解构（走查记录，2026-11-11）

三层结构：

| 层 | 内容 | 关键细节 |
|---|---|---|
| 产品级一页图 | feature 节点 + 连接线 + 产品级覆盖率（48%） | 节点带「N scenarios」或「N sub-features」；悬停连线看两功能如何关联；点击钻入 |
| feature 级 | Scenarios \| Flow diagram 两 tab + 一句话行为叙事 + 该 feature 覆盖率（37%） | 叙事是起点状态→终点状态（“带着没有组织/项目/计划的空账号进来，带着三者齐备离开”） |
| flow 级 | Start→End 行为流 | 决策节点=问句（“Did GitLab accept the token?”）；错误分支=用户可见后果（“nothing saved”、“Banner naming what failed, with a reconnect”）；边上标状态（accepted/rejected/over the limit…） |

其叙事定位：map 是**非工程读者的入口**，digest / release notes 是周期出口（demo guide 顺序：「一页 map → Digests → Release notes」）。

## 2. 与 RepoMap 的互补边界

RepoMap 项目（另一条产品线）做**技术架构图生成**：代码空间——模块、依赖、调用、部署结构。

| | RepoMap 架构图 | CoDelphi 产品地图 |
|---|---|---|
| 空间 | 代码空间（怎么实现的） | 行为空间（产品做什么、怎么变、出了错用户看到什么） |
| 读者 | 工程/架构师 | 产品、市场、销售、客户、CTO |
| 变化语义 | 结构重构 ≠ 行为变化 | 结构重构零变化，行为变化必现 |
| 证据形态 | 静态分析/依赖关系 | 场景 + 证据文件 + 人工核实签发 |

**边界红线**：本立项不复活已下线的系统架构图（`docs/specsight-gap-improvement-plan.md` §5.3、`README.md:40`、architecture-facts 非目标）。B3 注释里已写明「只做功能之间的关系，不复活架构图」（`lib/feature-connections.ts:5`）。

**互补的验收方式**（放 dogfood 试验）：两图对**同一个仓库**（CoDelphi 自体）各自生成，人工对照检查：①行为地图不出现纯代码结构节点（模块/层/中间件）；②架构图不出现场景级行为描述；③两图对同一次重构的判定不一致（架构图大变、行为地图零变化）作为互补性的正面证据。

**不做的集成**（本立项不含，留开放问题 §8）：证据文件路径是两图的自然对齐键（B3 共享文件 ↔ RepoMap 模块节点），长期可互链；现在不做自动集成，避免两条产品线过早耦合。

## 3. 现状对账：每个要素都已有原料

| Specsight map 要素 | 我们已有的 | 证据 |
|---|---|---|
| 节点 = feature + 一句话描述 | `features.summary` / `spec_features.summary` | `migrations/001_initial.sql:76`、`migrations/002_spec_versions.sql:16` |
| 子功能层级 | `spec_features.parent_key` | `migrations/002_spec_versions.sql:23` |
| 场景计数 | scenario 按 feature 计数（功能树已在用） | `lib/product-details.ts:46` |
| 边 = 功能关联 | **B3 确定性连接已实现**：共享证据文件面、双向、Top5、逐条带依据 | `lib/feature-connections.ts`、`app/api/products/[slug]/features/[id]/connections/route.ts`、`components/feature-connections-panel.tsx` |
| Flow diagram | 功能内流程图已实现（happy 主干 + 分支） | `lib/feature-flow.ts`、`components/feature-detail.tsx:58` |
| 覆盖率上墙 | 完整性账本（六维度，比 Specsight 公开口径更严格） | `lib/completeness-ledger.ts`、`components/product-navigation.tsx:65` |
| 一级导航位 | 产品视图 tabs 已有概览/规格/发布稿/发布变化 | `components/product-navigation.tsx:41-46` |

**缺的只有一个**：产品级一页合成（view=map）。这是 S–M 规模的合成任务。

## 4. 设计（M1 · 地图页 MVP）

### 4.1 页面结构

新一级视图 `?view=map`，导航项「产品地图」（入口显眼，遵循用户入口偏好）：

- **节点**：顶层功能 + 子功能分组（复用 `buildFeatureTree`），每个节点显示：功能名、场景数、（M3 加）完整性徽章。节点取自规格版本链当前版本（与规格页同一数据源，不引入新口径）。
- **边**：B3 确定性连接（共享证据面）。边的悬停/点开展开依据：共享文件清单 + 两侧引用场景（复用 `FeatureConnection.sharedFiles` 现有结构）。边不画方向箭头（B3 注释：同向有语义争议，先统一标注「共享证据面」）。
- **点击节点** → 跳转现有功能页（场景 | 流程图两 tab 已在）。
- **空态显式**：连接为 0 边时页面仍完整渲染节点，并显式说明「尚无共享证据面连接（B3 确定性层未产出）」——**不得静默隐藏**（现状 `feature-connections-panel.tsx:27` 空数据 return null，地图页不复用该行为；入口偏好的直接教训）。

### 4.2 布局与实现约束

- **确定性布局**，不用力导向/拖拽画布。顶层功能按功能树分组排布（网格/分层），子功能折叠为组内计数。零新依赖（不引 d3/reactflow——红线外的新约束：地图是读的面，不是编辑的面）。
- **视图层零 DB 依赖**：地图数据装配放服务端 lib 模块，类型抽到视图层零依赖模块（R1 的教训：`lib/completeness-ledger-view.ts` 模式）；客户端组件不 import 服务端模块防 bundle 污染。
- **边数量护栏**：共享证据面连接在 utils 类共享密集的仓库可能爆炸。沿用 B3 现有 Top-K 语义（按共享场景引用数排序截断），页面显式披露「已截断，共 N 条」；截断数与理由可查，不静默。
- **连接计算服务端化**：B3 现在是按 feature 的 API 路由；地图页需要产品级一次算全量。新增产品级装配函数（读 spec_file_index + 场景证据，复用 `buildFeatureConnections` 纯函数，不重写算法）。

### 4.3 明确不做（M1）

- 覆盖率百分比上墙（M3，口径待裁决，见 §8 裁决点 2——完整性账本是产品级/run 级，per-feature 覆盖率目前没有定义过的口径，不现造）。
- 变化叠加（最新发布高亮受影响功能，M3）。
- LLM 推断层（Leads to / Triggers）——B3 注释明确「待第一版真实使用数据后再评估」，本 map 页就是那个「真实使用」的载体（M4 待定，不放本立项验收线）。
- Ask / 检索入口、导出、分享页。

## 5. Dogfood 试验设计（M2 · CoDelphi 自体）

### 5.1 试验设置

- **对象**：CoDelphi 自身仓库（GitHub）建内部产品空间，跑完整首分析（多趟，≤6 趟）。
- **环境**：**生产环境、内部工作区**，不在本地 dev 跑——教训在册：本地 dev 误触发的 run 会被生产 sweep 认领产生双跑（run 54 事件）；dogfood 必须走真实管线（真实 webhook/sweep/计费记账）结论才可信。
- **成本记账**：SAU 1/run + `llm_call_receipts` 多趟如实记账，照常对账（顺带验证多趟计费路径 W0-5 在自家仓库上的表现）。

### 5.2 评估维度与验收

| # | 维度 | 验收线 |
|---|---|---|
| D1 | 选择质量 | tests / migrations / docs / scripts 不大量涌入场景证据；若涌入，暴露的是 W0-8 行为面枚举对「非运行时代码重要性先验」的真实表现——记录并回填到选择质量线，不是 map 页的锅 |
| D2 | 功能命名 | 功能名按交付语义可读（如「行为账本」「发布动线」而非「lib/xxx 模块」）；不合格项走 manual 修正并记录 |
| D3 | 连接噪声 | B3 边人工抽查：每条边点开依据成立（共享文件确实两侧被引用）；噪声率 >30% 触发 Top-K/阈值调整 |
| D4 | 一屏可读 | 功能节点数在本仓库规模下（预期 10–30 顶层）一屏可读；子功能折叠有效 |
| D5 | 两图对照 | 与 RepoMap 对同一仓库的架构图并排评审，产出互补性结论（§2 的三条检查）；**该结论是本立项放产线的放行件** |
| D6 | 变体累积 | BM-5 噪音（场景变体累积）在 map 场景计数上的可见度；40 帽截断日志观察（`lib/ai.ts` capScenariosPerFeature） |

### 5.3 放行逻辑

D5 + D3 通过 → M3（徽章+叠加）进入产线；D5 结论若为「两图高度重叠/读者混淆」，本立项收缩或重定位后再放行——这是把「互补」从事后说法变成试验结论的关键一步。

## 6. 批次与闸门

| 批次 | 内容 | 依赖 | 规模 | 放行闸门 |
|---|---|---|---|---|
| M1 | 产品地图页 MVP（view=map，确定性合成，零新依赖） | 无（B3 已落地） | M | 节点/边/钻入/空态四要素可用；typecheck+test+build 过；对已有产品（如生产现有产品空间）地图可读 |
| M2 | CoDelphi 自体 dogfood + 评估报告（含 D5 两图对照） | M1 | M | §5.2 六维评估成文；D5/D3 结论明确 |
| M3 | 完整性徽章上墙 + 最新发布受影响功能高亮叠加 | M2 放行 | S–M | 徽章与完整性账本数据一致；高亮集合与发布 changeGroups 按功能聚合一致；空态不隐藏 |
| M4（待定） | 边措辞行为语言化 / LLM 推断层评估 | M2 真实使用数据 | S | 推断类连接逐条带依据标注 + 抽查错误率记录（B3 §5.3 验收原文） |

M1 与 M2 可穿插（先对生产现有产品空间做 M1 验证，dogfood 空间建好后即用真页面评估）。

## 7. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | bundle 污染（客户端组件误 import 服务端/DB 模块） | 数据装配 lib 与视图类型分离（零依赖模块模式，R1 先例） |
| R2 | B3 连接在共享密集仓库爆炸/噪声 | Top-K 截断 + 显式披露截断数；D3 抽查闸门 |
| R3 | BM-5 变体累积使场景计数失真 | 40 帽已在（6701e1e）；D6 观察项，根因治理归 BM-5 不入本立项 |
| R4 | 「共享证据面」边被读者误读为调用/依赖 | 边标签固定「共享证据面」+ 依据可点开；不画箭头；页面口径注脚 |
| R5 | 与规格页口径漂移（地图数据与规格页不一致） | 单一数据源：同规格版本链当前版本装配，不另立口径 |
| R6 | dogfood 在本地误触发双跑 | 明确生产内部工作区执行（§5.1） |

## 8. 裁决点（2026-11-11 已全部裁决）

1. **地图入口**：✅ 已裁决——一级视图 `?view=map`。
2. **per-feature 覆盖率口径**：✅ 已裁决——M3 徽章先用事实统计（已核实场景数 / 场景总数 + manual/generated 构成），不做 per-feature 覆盖率口径定义。
3. **dogfood 工作区归属**：✅ 已裁决——hanlei@gmail.com 的个人工作区（org 3）。
4. **RepoMap 对照试验**：✅ 已裁决——RepoMap 仓库在 `../repomap`，可随时查看进度，与其负责的 agent 协调 D5 对照试验。

## 9. 修订记录

| 日期 | 版本 | 说明 |
|---|---|---|
| 2026-11-11 | v1 | 初稿。依据 Specsight demo 走查 + B3 现状对账；dogfood=CoDelphi 自体；含 RepoMap 互补边界与对照试验设计 |
| 2026-11-11 | v1.1 | 四项裁决点全部拍板（§8），M1 开工 |
