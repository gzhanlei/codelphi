# MCP 价值环正式试点记录（Face B 裁决实验）

依据：`docs/superpowers/specs/2026-11-16-mcp-agent-value-loop-design.md` §9（价值试点与停止条件）。
背景：Kimi Code 非正式测试结论为「MCP 作默认工作流无净价值」，已拍板降级为按需复核。本试点是 Face B（agent 编码决策增强）的唯一翻案机制：**在自家账本最厚的仓库上，若正式试点仍测不出独立发现，Face B 正式降格为「人类的证据索引、agent 机会性消费」，路线图删除全部 agent 增益宣称，不再回头。**

## 被试与纪律

- **被试**：coding agent（ZCode / GLM），在 CoDelphi 自家仓库 dogfood。
- **适配**：spec 的「开发者初始判断」= agent 在**任何 MCP 调用之前**写入本文件的书面判断（影响面猜想、拟修改方案、验证计划、真未知项）。判断先于输出，禁止事后补写。
- **污染披露（预先声明）**：被试的持久记忆含本仓库大量先验（既往修复、红线、坑）。因此「独立发现」的计分口径收紧为：**MCP 返回了先验、本次会话已读代码、其他检索工具三者都不能给出的事实**。仅找到文件路径/行号这类 grep 可得信息，计「低成本检索」不计独立发现。
- **成本口径**：agent 场景的净时间收益替换为**上下文 token 成本**（调用次数 × 响应规模）；MCP 响应不可裁剪地进入上下文，这是 agent 使用 MCP 的真实边际成本。
- **无自动遥测**：本文件即全部记录；调用数与响应规模按会话观测粗记。

## 指标（沿用 spec §9）

独立发现 / 决策促成 / 重复确认 / 净成本 / 无效打扰率 / 错误关联造成的额外工作量。分层报告：A 层=账本覆盖区任务，B 层=radar 新模块任务（预期零覆盖），C 层=运维杂项。

## 停止规则（预先承诺）

- Tranche 1（5 任务）后中期读数：若 A 层任务独立发现 = 0 且决策促成 = 0，**终止试点并执行降格裁决**（不再烧 tranche 2+）。
- 若 tranche 1 出现 ≥1 个独立发现或决策促成，继续 tranche 2（覆盖区再 5 任务），累计 ≥20 后按 spec 出最终报告。

## 任务登记表（草案，均为真实待办；随执行增删）

| # | 层 | 任务 | 来源 | 预期覆盖 | 状态 |
|---|---|---|---|---|---|
| T1 | A | #12 裁决 sweep 证据路径从主张文本优先提取 | 记忆 backlog | 高 | tranche 1 |
| T2 | A | BM-5 残余 keeper↔去重近似对线下折叠 | 记忆 backlog | 高 | tranche 1 |
| T3 | C | deploy.sh「prev=」日志显示误导修正 | 记忆 backlog | 零 | tranche 1 |
| T4 | B | P0-1 SnapshotIdentity 扩展 treeSha/originRemote | 本日设计文档 | 零（types/git-backend 已预暴露为空） | tranche 1 |
| T5 | B | P0-3 报告分区计数口径修正（430 vs 117） | 本日设计文档 | 零 | tranche 1 |
| T6 | B | P0-2 snapshot.json 确定性导出 | 设计文档 | 零 | 待排 |
| T7 | B | 渲染层四件套（IA 重排/规格分层折叠/搜索筛选/命名澄清） | 外评收敛 | 零 | 待排 |
| T8 | B | concepts v2 生命周期层 | 外评收敛 | 零 | 待排 |
| T9 | B | test map 级 1（测试文件↔证据路径交集） | 外评收敛 | 中（触及账本侧） | 待排 |
| T10 | B | P0-4 导入端点（服务端新模块+既有中间件） | 设计文档 | 低-中 | 待排 |
| T11 | C | coverageExplainer（fec0478）推进推/部署 | 记忆 backlog | 低 | 待排 |
| T12 | C | docker 漏洞残留 2 Medium 提交部署 | 记忆 backlog | 零 | 待排 |
| T13 | C | radar SKILL.md 定位话术更新（L1） | 设计文档 | 低 | 待排 |
| T14 | B | P0-7 upload 子命令 + snapshot:write 作用域 | 设计文档 | 中（API key 面） | 待排 |
| T15 | B | P0-8 导入赠 SAU | 设计文档 | 中（gift 钱包面） | 待排 |
| T16 | A | lookup_by_files >50KB 截断护栏测试补齐 | 记忆 backlog | 高 | 待排 |
| T17 | A | M9 影子评测 consistent=false 处置 | 记忆 backlog | 未知 | tranche 2 |
| T18-T20 | — | 余量（随真实任务增补） | — | — | — |

---

## Tranche 1（2026-11-18）

### T1 裁决 sweep 证据路径从主张文本优先提取 —— 初始判断（MCP 前）

- **任务**：生产 AI sweep 把证据不足的反馈自动裁决为 needs_human（诚实降级，见 #12）；改进方向=裁决时证据路径优先从主张文本提取，减少误降级。
- **影响面猜想**：裁决 sweep 的 prompt 构造与解析层。**真未知：确切入库文件路径**（我只知道功能名 feedback-adjudication，不知道 sweep 代码在哪个文件）。
- **已知先验（污染源）**：#12 结论与改进方向已在我记忆里；sweep 有 AI 裁决管线、verification 状态机、报告仓库锚定（bf975e7 修过）。
- **MCP 预期**：search_scenarios 应能定位裁决 sweep 场景及其证据路径；lookup 该路径应给出爆炸半径与相邻红线场景（如 manual 保护、裁决状态机不变量）。
- **拟验证计划**：定位文件后读 prompt 构造段；改提取逻辑前核对 spec_verifications 关联链不受扰动。

### T2 BM-5 残余 keeper↔去重近似对 —— 初始判断（MCP 前）

- **任务**：BM-6 A3 确定性变体折叠上线后仍有 keeper↔去重脚本近似对残余（summary 维度线下未折）；目标=把线下折叠判据对齐，折掉残余近似对。
- **影响面猜想**：去重/折叠脚本与 BM-6 折叠判定逻辑。**真未知：近似对判定阈值代码位置、脚本是 scripts/ 还是 lib/**。
- **已知先验**：BM-6 A3=等价捷径+0.5 合并兜底；FUR=0 是红线（真变体不得被折）；残余问题是 summary 线下未折。
- **MCP 预期**：「确定性变体折叠」场景有证据锚点可定位判定代码；lookup 可给出折叠门禁相邻红线。
- **拟验证计划**：改判定前跑 BM-6 门禁全套 + FUR=0 验收。

### T3 deploy.sh「prev=」日志误导 —— 初始判断（MCP 前）

- **任务**：deploy.sh 日志「prev=」显示误导但回滚链功能正确；修正显示逻辑。
- **影响面猜想**：deploy.sh 单文件。预期 MCP 零覆盖（运维脚本）。
- **MCP 预期**：空结果；本行测空结果路径的调用成本。

### T4 P0-1 SnapshotIdentity 扩展 —— 初始判断（MCP 前）

- **预暴露声明**：设计文档阶段已 lookup 过 `lib/snapshot/types.ts`、`git-backend.ts`（均空）与 `lib/ai.ts`（两个功能 13+2 场景）。本行测剩余文件（target.ts/workspace.ts）是否同样空，及空结果之外的任何增量信息。

### T5 P0-3 分区计数口径修正 —— 初始判断（MCP 前）

- **任务**：报告「分析分区 430」vs work dir 实际 117 工单，疑断点复用残留计数；修正展示口径=实际 work orders。
- **影响面猜想**：report-data.ts / report-html.ts。**真未知：430 的确切来源**（断点复用残留是假说）。
- **MCP 预期**：零覆盖空结果；430 来源只能靠读代码解决——本行同时检验「MCP 对账因定位类问题是否有任何帮助」。

### —— 执行结果（2026-11-18，MCP 后） ——

**调用记录**：search_scenarios ×5（「反馈裁决 sweep 证据路径 needs_human」空 / 「AI 裁决 反馈核实」空 / 「adjudication sweep feedback」空 / 「裁决」命中 / 「变体」命中 / 另「变体折叠 去重」空）；lookup_by_files ×4（target.ts / workspace.ts / report-data.ts / deploy.sh）+ 设计文档阶段 4 次（预暴露）。**响应规模**：search 命中单次原始 73KB（客户端截断至 50KB）；lookup 命中单次约 15-25KB；空结果 <1KB。

**T1 结果（A 层）**：
- 命中「反馈 AI 自动裁决」功能（lib/feedback-adjudication.ts + lib/feedback.ts:23 buildAdjudicationPrompt）。
- **决策促成 1 条**：场景 EC-2（release 275 新增）钉住了行为「近期变化零证据路径 → 即使 confirmed_defect+high 也降级 needs_human，有测试锚 tests/feedback-adjudication.test.ts:106」——这正是 #12 要改的降级路径，且它是**有测试锚的刻意契约**而非 bug。我的初始计划只核对 verification 关联链；现在计划须增加「改证据路径提取时同步评估 EC-2 契约是否需要修订」。
- 重复确认 2 条：多仓库锚定（HP-3/4/5，记忆已有 bf975e7）；buildAdjudicationPrompt 文件位置（grep 可得，计低成本检索）。
- 噪声：history 段约 80% 字节是 release 219/224 时代的 admin UI 场景变体增删（HP-8..HP-16 反复增删——正是 BM-5 变体爆炸的读侧残迹），与任务无关。

**T2 结果（A 层）**：两个查询词空、宽词「变体」命中「多趟提取结果合并」（合并语义描述有用）但未给出线下近似对折叠的脚本位置——对具体任务帮助不足。任务定位仍需 grep。

**T3/T4/T5 结果（B/C 层）——预测被证伪，独立发现**：
- **初始预测全部错误**：我预测四个文件零覆盖空结果，实际 target.ts（功能 20080「产品现状快照生成」8 场景）、workspace.ts（功能 20069「产品快照分析工作区」11 场景）、report-data.ts（EC-1..EC-4 证据预算/不可用契约）、deploy.sh（「生产部署与回滚」+「Docker 构建与部署」两个功能 10 场景）**全部有覆盖**。设计文档阶段我只查了 types.ts 和 git-backend.ts（恰好真空）并错误推广到整个模块。
- **独立发现（严格口径）1 条**：账本对 radar 模块与部署脚本的覆盖及红线场景清单（workspace_target_mismatch / ER-1 Missing snapshot results / deploy.sh 回滚链语义），grep/LSP/已读代码均不能给出——**且纠正了先验错误**。
- **决策促成 1 条**：设计文档 §15「lib/snapshot/* 反查为空」结论错误，须修正；P0-1/P0-2/P0-3 的对账锚点应为功能 20080/20069 的场景（含 HP-3 finalizeSnapshotWorkspace 合并点=导出落点、EC-3 skippedExisting=计数 430 疑点的机制旁证）；T3 改 prev= 日志不得触碰 ER-1/ER-2 回滚语义。
- **机制旁证（意外收获）**：workspace EC-3（skippedExisting 跳过已有工作单）为「430 vs 117」计数疑点提供了机制解释方向——旧批次工作单被跳过但计数器未同步。

**成本与噪声汇总**：
- 有效信息/总字节比：search 命中响应约 20%（history 变体噪声占大头）；lookup 命中响应约 60% 但含**重复条目**（HP-2/ER-1/EC-5 各出现两次——读侧去重缺失的实证）。
- 查询词摩擦：6 个查询 3 空；正确功能名「反馈 AI 自动裁决」与我用的词形差异导致前三连空。
- 空结果成本假设证伪：B/C 层并不空——**lookup 在「我自以为知道」处的价值最高（打脸先验），在真空白区才会是零信息**。

## Tranche 2（2026-11-18，覆盖区 5 任务）

### T6 P0-2 snapshot.json 确定性导出 —— 初始判断（MCP 前）

- **任务**：radar run 收尾时确定性导出合并快照 snapshot.json（设计文档 §4）。
- **影响面猜想**：落点=workspace.ts 的 finalizeSnapshotWorkspace（功能 20069，**tranche 1 已预暴露**：HP-3 合并+报告产出+返回 analysis/report/html/outputPath）；另涉 scripts/snapshot.ts（**未反查过**）与 report-data 组装链。
- **真未知**：scripts/snapshot.ts 收尾调用链形状；run.ts 是否须触碰；导出物从 analysis 还是 report 组装更稳。
- **MCP 预期**：scripts/snapshot.ts 反查可能空（CLI 入口未必是证据）；workspace.ts 红线已知（ER-1 缺结果不产报告、EC-5 未知工作单）。
- **拟验证计划**：导出函数放 workspace.ts；确定性=同 work dir 两次导出逐字节一致（数组保序不排序）；旧 work dir 缺新字段如实置空。

### T14 P0-7 upload 子命令 + snapshot:write key 作用域 —— 初始判断（MCP 前）

- **任务**：新增 API key 作用域 `snapshot:write` + CLI upload 子命令 + 导入端点限流（设计文档 §9）。
- **影响面猜想**：API key 签发/校验代码（**文件未知**——只知有 MCP key UI 与 key 面功能）；导入端点是全新路由。
- **真未知**：现有 key 作用域模型与枚举位置；key 校验中间件复用点；限流是否已有每 key 实现（记忆：/share/* 有限流桶，机制未知）。
- **MCP 预期**：search「密钥」应命中 key 面功能；lookup 证据文件应给出作用域枚举与校验链红线。
- **风险**：动 key 校验会碰现有 MCP 鉴权；限流复用错桶会自满。

### T15 P0-8 导入赠 SAU —— 初始判断（MCP 前）

- **任务**：首次导入成功赠 1 SAU，每 workspace 一次（设计文档 §11）。
- **影响面猜想**：gift 钱包发放逻辑（**文件未知**——记忆只知「订阅履约 gift 钱包」机制存在）；每 workspace 去重键。
- **真未知**：gift 发放函数位置、现有 gift 来源种类、去重维度（workspace 还是 user）、幂等保障。
- **MCP 预期**：search「钱包」命中发放功能；lookup 给出发放红线（幂等/来源枚举）。
- **风险**：双重赠予；gift 与扣减混账。

### T16 lookup_by_files >50KB 截断护栏测试 —— 初始判断（MCP 前）

- **任务**：多文件合查超 50KB 被客户端截断（数据无损、拆单路径即全量）——补护栏测试防回归，并核对 coverageExplainer（fec0478，未推）是否已覆盖披露。
- **影响面猜想**：截断发生在 MCP 客户端 resultBudget 层；护栏测试落 tests/mcp-*.test.ts；**真未知：截断确切层次（服务端 vs 客户端）与现有测试覆盖形状**。
- **MCP 预期**：lib/mcp/server.ts 反查已知为空（tranche 0）；projections.ts/operations.ts 未测——本任务是元任务：**MCP 能否帮助改进 MCP 自己**。
- **拟验证计划**：先定位截断层再定测试位置。

### T17 M9 影子评测 consistent=false 处置 —— 初始判断（MCP 前）

- **任务**：M9 影子评测持续 consistent=false（记忆 backlog，2026-11-11 遗留），处置=修好或下线。
- **影响面猜想**：影子评测代码（**文件未知**）；consistent 判定逻辑。
- **真未知**：全部——不知道影子评测是哪个功能、在哪实现、consistent 的判定依据。
- **MCP 预期**：search「影子」或「一致」命中与否本身就是数据点（功能若在账本中，应能命中）。

### —— Tranche 2 执行结果（2026-11-18，MCP 后） ——

**调用记录**：search_scenarios ×3（「密钥」「钱包」「影子」全部命中——tranche 1 学到的裸词策略有效）；lookup_by_files ×2（scripts/snapshot.ts 空、lib/snapshot/run.ts 命中）。响应规模：search 命中 40-70KB，lookup 命中 ~10KB。

**T6 结果（P0-2 导出）**：
- scripts/snapshot.ts 反查空（符合预期，CLI 入口非证据）；run.ts 命中功能 20080：**ER-4 红线（分析失败须 finally 清理目标+释放 host 会话）**是导出落点相关的真实约束——加导出不得破坏 cleanup 语义。计重复确认级（读代码可得）；对账锚点清单 +1。

**T14 结果（P0-7 upload + snapshot:write）——独立发现 1 + 决策促成 1**：
- **独立发现**：现有 MCP key 体系是**组织级只读、无 scope 模型**（功能 13251 摘要明示「签发组织级只读 MCP key」）。我的初始判断假设「在既有 scope 枚举上加 snapshot:write」——**设计假设错误**。P0-7 实际要给 key 表引入 scope 字段 + 迁移，且必须保证存量只读 key 对 upload 端点零权限（负向测试红线）。
- **决策促成**：限流复用 lib/rate-limit.ts 的固定窗口+行锁机器（HMAC 哈希键、429+Retry-After），且其 **fail-open 语义**（限流器故障放行+告警）是导入端点要显式决策继承还是改 fail-closed 的点——初始判断不知道这台机器存在。
- 噪声：history 混入 token-crypto/密钥环无关场景（「密钥」一词多义）。

**T15 结果（P0-8 导入赠 SAU）——决策促成 1**：
- grantQuotaByEmail（lib/billing/manual-grant.ts:42）即现成发放机器：**同一 reason 幂等（EC-1，重复提交 granted=false 不写钱包）+ 无钱包自动建试用钱包（HP-2）**。初始判断的三个真未知（函数位置/去重维度/幂等保障）一次查询全部命中且带测试锚。设计结论：导入赠予复用该机器，reason=`import-gift:<workspaceId>` 幂等键，**无需新建去重表**。
- 噪声（重要残渣证据）：4 个功能（手动配额发放/管理端按邮箱充值配额/超管手工充值/运营手工充值）描述**同一个** grantQuotaByEmail——账本侧变体折叠残余的又一次实证。

**T16 结果（截断护栏）——独立发现 1（元任务）**：
- **跨工具交叉发现：lookup_by_files 对 lib/mcp/server.ts 返回空，但 search 的 release 240 场景证据明确引用该文件 ：310/:311**——工具自身索引不一致（其一过期）。已按纪律 send_feedback（#23）。元任务回答：**MCP 帮助改进了 MCP 自己**（通过交叉验证暴露了 lookup 的覆盖漏洞）。
- 顺带获得 spec-search.ts 的 scope 语义场景（EC-3 空查询/ER-2 非法 scope/HP-3 fallback），对护栏测试位置有参考。

**T17 结果（M9 影子）——独立发现 1**：
- 「影子」一次命中。一致性判定契约完整揭晓：**功能 key 集合必须完全一致 + (reference, category) 集合宏平均 Jaccard ≥ 0.70**（功能 11051）；manual 条目剔除后比对（HP-30）、全 manual 功能按空集规则（EC-36）；实现位于 lib/incremental-shadow.ts:44/50。初始判断「真未知：全部」——现在处置路径明确：consistent=false → 取影子输出的 missingKeys/extraKeys 按上述阈值归因。

## Tranche 2 读数

| 指标 | 计数 | 备注 |
|---|---|---|
| 独立发现（严格口径） | **3** | ①key 只读无 scope 模型（纠设计假设）②影子一致性判定契约 ③lookup 漏报 lib/mcp/server.ts（跨工具交叉，已上报 #23） |
| 决策促成 | **2** | ①T15 复用 grantQuotaByEmail 幂等机器免新建表 ②T14 复用 rate-limit 机器+fail-open 决策点 |
| 重复确认 | 2 | run.ts ER-4 红线、spec-search scope 语义 |
| 查询命中 | 3/3 | 裸词策略（tranche 1 教训）生效 |
| 噪声 | 2 类 | 「密钥」多义混入；**4 功能同指一函数**（账本变体残渣） |
| MCP 附加成本（非净成本） | ≈120KB ≈30k token | 5 任务 planning |

## 累计读数（Tranche 1+2，10 任务）

- 独立发现 **5**、决策促成 **4**、重复确认 5；查询命中 8/12（裸词策略后 4/4）；净成本 ≈270KB ≈70k token。
- **模式稳定**：lookup 在「计划动 X 文件」时有结构化价值（覆盖/红线/锚点）；search 在「裸名词定位功能」时可靠、在「描述性短语」时失效；两者的产出**高度集中在纠正错误假设与暴露机器复用点**，而不是提供新知识。
- **产品改进 backlog 更新**（试点直接产出）：①lookup 读侧去重与漏报（#23）②search 词形容错/同义扩展已有（EC-2）但对功能名覆盖不足 ③search history 噪声占比 ④lookup 响应重复条目。这四项修完，净成本预期显著下降——**MCP 的有用性是可以工程化提升的，这本身推翻了「帮助不大=固有属性」的静态结论**。
- **对最终判决的含义**：20 任务全量判据尚差 10 个，但已有足够证据把「MCP 对 agent 无用」修正为分层结论——**计划阶段 lookup=有价值（正收益），检索定位=裸词可用（中性），描述性 search=负收益（待修）**。Face B 翻案路径清晰：修产品短板 → tranche 3 用修正后工具重测净成本。

## 修复阶段（2026-11-18，先修再测）

试点四项产品短板的处置结果：

1. **lookup 响应重复条目 → 已修**（`lib/feature-connections.ts` buildFileImpact）：根因=同一场景的多条证据指向同一路径时重复入列（真实案例：target.ts:74+:93 使 HP-2 出现两次）且 scenarioCount 虚高——恰好违反功能 13116 EC-1「scenarioCount 为真实总数」契约，本次是修 bug 非改契约。测试：同场景双证据计一次、跨路径各计一次。
2. **search 词形脆弱 → 已修**（`lib/spec-search.ts` queryVariants 重写）：分词召回（多词查询任一词命中即可）+ CJK 复合词前后 2 字 gram（「反馈裁决」→ 反馈/裁决，可命中「反馈 AI 自动裁决」）+ 命中变体数相关性排序（稳定排序，同分保 SQL 序）。与 EC-2「只扩大召回不改行为身份」同向；单词查询语义逐字节不变（既有测试全部保持通过）。
3. **history 变体兴替噪声 → 已修**（searchReleaseHistory）：同一 (feature, scenarioReference) 的 added/removed/changed 兴替链只保留最新一条（超采 2 倍池去重后截 30），直接压缩 release 219/224 admin UI 兴替洪泛那类噪声。
4. **lookup「漏报」lib/mcp/server.ts → 误报结案**：get_feature 核实功能 13251 当前场景证据全部在 components/mcp-keys-settings.tsx，server.ts 引用只在 release 240 历史中——**lookup（当前快照）正确，是我误读工具语义**（search 含历史）。已上报更正（feedback #24）防误触发修复性重建。产品启示（未实施）：lookup 对「历史有证据、当前已无」文件可返回披露提示。

改动文件：`lib/feature-connections.ts`、`lib/spec-search.ts`、`tests/feature-connections.test.ts`、`tests/spec-search.test.ts`。验证：vitest 定向 60/60、typecheck ✓、全量测试 0 失败、build ✓。**未提交未部署**——重测（登录改造场景）须待部署后执行，否则测的是旧工具。

---

## Tranche 3（2026-11-18，修复后重测：登录方式改造规划）

**部署基线**：sha-5d0d118 已部署生产（release 279 对账 unexpected=[]）；活体验证——tranche 1 三连空的查询词「反馈裁决 sweep 证据路径 needs_human」现已命中（含目标场景）。

### T18 登录方式改造：Chandler 跳转 OAuth → 自建注册/登录 UI 调 Chandler API —— 初始判断（MCP 前）

- **任务**：把「跳转 Chandler 网站登录」改造为「站内自建注册、登录界面，调用 Chandler API 完成注册与登录」。
- **影响面猜想（先验，含污染源标注）**：OAuth 回调与安全跳转（lib/oauth.ts:11 safeNextPath、lib/oauth-request.ts:11 parseOAuthCallback——刚才部署验证的 search 白送的）；Chandler 用户令牌持久化与刷新（lib/chandler-token.ts，单连接刷新刚修过）；Chandler 令牌加密密钥环（lib/token-crypto.ts，32 字节 keyring）。会话建立点（cookie/DB session 表）**真未知**；登录页落点（记忆：login/403/terms 为无壳页）。
- **真未知（重点）**：①Chandler 侧注册/登录 API 形态（password grant？注册端点？）——**账本只记载我们自己的代码，外部 API 契约大概率不在账本内**，预期 MCP 在此处无能为力，须问 Chandler 文档/团队；②会话表/中间件鉴权链的实现位置；③无壳登录页的现有渲染链。
- **MCP 预期（修复后工具）**：一次宽词查询「登录 注册 会话 OAuth」应召回登录面全部功能（tranche 1 同类查询 3 连空，本次预期 1 查命中）；lookup lib/oauth.ts、lib/chandler-token.ts 应给出红线（safeNextPath 只许站内、令牌 keyring 32 字节、单连接刷新）；AGENTS.md 红线「不新增账号密码体系」被本任务显式推翻，计划中须声明。
- **拟验证计划**：先确认 Chandler API 契约（外部），再定 UI 落点与会话链改造；令牌持久化/刷新链应零改动复用。

### —— Tranche 3 执行结果（2026-11-18，修复后工具） ——

**调用记录**：search ×1（「登录 注册 会话 OAuth」，~60KB）+ lookup ×2（lib/chandler.ts、lib/oauth-request.ts，各 ~8KB），**合计 3 调用 ≈76KB**。

**召回对比（修复前 vs 后）**：tranche 1 同类定位 6 查 3 空、命中响应 73KB 且 ~80% 无关；本次 **1 查命中 16 功能 + 30 场景**，覆盖整个登录面（Chandler OAuth 登录/OAuth 回调与安全跳转/令牌持久化与刷新/个人工作区引导/登录错误提示/组织邀请/公开页外壳），排序把最相关功能置顶；lookup 响应无重复。**分词+CJK gram+排序+history 去重四项修复全部生效且被账本自动记为新场景**（15483 HP-3/HP-4）。

**计划增量（登录改造的真实收获）**：
- **独立发现 1 条**：「登录时自动认领无 token 的待处理邀请」（功能 6097 组织邀请与成员加入）——登录链的隐藏业务副作用，自建登录 UI 后必须保留该认领时机；初始判断完全未列出，grep 不可得（语义副作用）。
- **决策促成 2 条**：①邮箱白名单 assertChandlerAllowed（lib/chandler.ts:37，EC-1 forbidden）在自建注册流中的位置成为显式设计决策（白名单是否拦截注册）；②getValidUserToken 的「4xx 清行引导重登录」语义（lib/chandler-token.ts:120）要求登录错误提示（功能 2623）扩展新错误码并与重登录路径对接。
- **重复确认 5 条**：parseOAuthCallback/safeNextPath/storeChandlerTokens/getValidUserToken/ensureUserWorkspace 均与先验一致（这些是确认不是发现）。
- **MCP 盲区确证（预测命中）**：Chandler 注册/登录 API 契约不在账本（账本只记自家代码）——改造计划必须外部求证，MCP 在外部依赖上诚实地无能为力。

**残余噪声（下一轮产品项）**：①令牌功能 ER-1/ER-3 近重复（同文件不同引用，兴替去重管不到——账本侧变体折叠残余的读侧表现）；②分词召回的歧义命中（「注册」一词召回产品注册/业务分组等无关功能）——排序已缓解但未消除。

## Tranche 3 读数与全试点小结（11 任务；2026-11-19 按 Kimi 外评修正口径）

> **修正声明（2026-11-19）**：本节初版有三处口径错误，已按外部评审修正——①T18 成本实为 ≈76KB（初版「≈20KB」为算术错误）；②「成本降为 1/4」撤回（分母不可靠且未测无 MCP 反事实）；③独立发现严格口径重算为 4（T16 漏报已证误报撤回、EC-2 为宽松计入不计入严格头条数）。本节降格为**中期报告**，最终判决须补齐剩余 9 任务或完成决定性对照。

| 指标 | T1-T2（修复前） | T18（修复后） |
|---|---|---|
| 定位查询数 | 6 查 3 空 | **1 查命中** |
| 响应噪声占比 | ~80% / 重复条目 | 低（残渣仅近重复对） |
| 独立发现（严格口径） | 3（纠先验覆盖/key scope/影子契约；另 EC-2 宽松 1） | 1（邀请认领） |
| 决策促成 | 4 | 2 |
| MCP 附加成本 | ≈270KB/10 任务（均值不可靠：含 3 个近零空任务） | ≈76KB/1 任务 |

**已确立的结论**：
- 决策质量提升是真实且最有说服力的信号——T14 key 无 scope 模型、T15 grantQuotaByEmail 幂等复用、T18 登录邀请认领，都会实质改变设计（避免错误方案进入实现），其价值不是省 token。
- Face B 有效形态收敛为：**账本覆盖良好的仓库中、供 agent 计划阶段使用的行为约束索引与复用点发现工具**。不是默认编码工作流、不是持续判据、不是外部 API 契约来源。
- 「有用性是工程变量不是固有属性」成立（修复确实改变了工具产出）。

**未确立、不得宣称的**：
- 「净收益转正」——只测了 MCP 附加成本，未测无 MCP 反事实（检索+阅读+错误计划+返工总成本）。
- 「成本降为 1/4」——已撤回；查询 6→1 是真实的，但单次召回变大，上下文成本未必下降。
- 「最终翻案」——11 任务只能中期结论；预先承诺的停止规则只规定了差则终止，未规定好则提前翻案。

**归因隔离声明**：T18 改善同时混杂了①产品修复②裸词查询策略③工具语义理解加深④任务类型四个变量，不能全部归因于修复。决定性对照设计：干净上下文中对同类规划任务跑「grep/读代码」vs「MCP+grep/读代码」，记录全程 token，由独立评审判遗漏约束/错误假设/复用机会；最优方案是重跑 tranche 1 原始任务。

**下一步（按 Kimi 建议采纳）**：①修正试点账本（本节）②决定性对照实验 ③输出压缩：search 默认 top-K 摘要+stableKey 深入、history 按需展开、红线/约束字段紧凑返回——否则召回越好上下文负担越大。

## 输出压缩落地（2026-11-19，Kimi 建议③）

- **改动**：MCP 边界新增 `compactSearchProjection`（lib/mcp/projections.ts）——features 截 top-8、scenarios 截 top-10（只留 id/featureName/stableKey/reference + 证据 path+startLine 锚点，全文与 url 剥离）、history 截 top-10（**剥离 before/after 正文**，只留定位字段）、附 `detailHint` 指明 get_scenario/get_release 深入路径、截断时 `truncated: true`。`lib/spec-search.ts` 排序与召回语义不动（explainer 等内部调用方不受影响）。
- **工具描述同步**：search_scenarios 描述更新，明示摘要投影与深入路径。
- **测试**：mcp-projections 新增 2 用例（top-K 截断+锚点保留+正文剥离+排序不重排+空态 hint）；全量 typecheck/test/build 绿。
- **未提交未部署**——部署后跑决定性对照（Kimi 建议②：干净上下文重跑 tranche 1 原始任务 ±MCP，全程 token 记录+独立评审）。

## 决定性对照实验（2026-11-19，Kimi 建议②执行）

**设计**：4 个干净上下文子代理并行（2 任务 × 2 臂；被试无对话历史无记忆先验，污染远低于主会话重跑）。T1=裁决证据路径提取规划，T2=summary 近似变体折叠规划。A 臂仅本地检索（禁 MCP），B 臂可用 MCP。对称限制：双方禁读 docs/superpowers/pilots/（答案键源头）、禁访 codelphi.com。产出=计划文件，独立评审子代理盲评（评分口径/答案键见 /tmp/exp-answer-key.md）。

**原始数据**（子代理 token 由 harness 报告，全程记录）：

| 臂 | 任务 | 约束命中 | 错误假设 | 复用分 | 评审总评 | 子代理 token | 工具调用 |
|---|---|---|---|---|---|---|---|
| B（MCP） | T1 | **6/6** | 0 | 2 | **10/10** | 1.06M | 25 |
| A（本地） | T1 | 5/6 | 0 | 2 | 8/10 | 1.13M | 24 |
| B（MCP） | T2 | 5/6 | 0 | 2 | 8/10 | **1.46M** | 28 |
| A（本地） | T2 | 5/6 | 0 | 2 | 8/10 | 2.70M | 42 |

**评审修正两处（透明记录）**：①评审子代理的文件标签 P1/P2/P3 错位（内容分析正确但张冠李戴），已按内容标记（collectEvidenceFiles/asSpecScenario/lookup_by_files 出现频次）复核重映射；②答案键约束 1（buildAdjudicationPrompt 在 lib/feedback.ts）**过期**——当前代码该函数在 lib/feedback-adjudication.ts:51，两臂按当前事实命名被判「prompt 位置错误」系答案键错，扣除项撤销、约束 1 改判两臂命中。

**实验结论**：
1. **质量**：MCP 臂 T1 显著优（6/6 约束+账本闭环+push 后对账计划 vs 本地臂漏 sweep 三不变量）；T2 平手且互补（B 账本工作流+新鲜度核验，A 数值级实证+复现脚本）。
2. **成本**：T1 持平（1.06 vs 1.13M）；T2 B 臂省 **46%**（1.46 vs 2.70M）。净收益方向首次获得受控证据——**MCP 臂质量不低于本地且成本不高于本地**（单任务对样本，n=2，外推谨慎）。
3. **收敛信号**：T2 两臂独立定位同一根因（scripts/merge-variant-features.ts 的 asSpecScenario 硬编码 evidence=[] 使离线判据退化）——互证为真根因，且该发现本身可归入 T2 任务的独立发现。
4. **元发现（第 7 条独立发现，严格口径）**：**答案键过期问题实锤**——tranche 1 经 search 历史获得的事实（prompt 在 lib/feedback.ts）在 HEAD 已不成立，评审差点据此错判两臂。当前账本快照是对的、历史也对（当时），错的是「把历史事实当当前事实用」——**stale 门（证据对 HEAD 的新鲜度标注）的产品必要性被对照实验反向实证**，排入产品 backlog 最高位。
5. 归因隔离达成：工具差异是两臂唯一差异（任务/提示/限制对称），改善可归因于工具而非查询策略学习。

**对最终判决的更新（2026-11-19 按 ChatGPT 反馈收紧措辞）**：配合 11-18 的四项修复与输出压缩，决定性对照给出受控证据——**在本次两个配对规划任务中，MCP 臂的约束覆盖不低于本地检索臂，Agent 总 token 消耗不高于本地检索臂。该结果支持在账本覆盖良好的仓库中保留计划阶段的 MCP 使用，但尚不足以证明对其他仓库、任务类型和 Agent 的普遍收益。**（原「MCP 臂质量≥本地臂、成本≤本地臂」的普遍化措辞作废。）Face B 维持有条件保留窄定位：计划阶段的行为约束索引与复用点发现工具，价值主张=减少错误假设与计划遗漏。

## 独立发现登记表（2026-11-19 统一口径，ChatGPT 反馈要求）

| ID | 来源 | 内容 | 严格口径 | 改变决策 | 状态 |
|---|---|---|---|---|---|
| F1 | T1/T4/T5 | radar 模块与 deploy.sh 实有账本覆盖+红线清单（纠「反查为空」先验） | ✓ | ✓ 设计文档 §15 重写 | 确认 |
| F2 | T1 | EC-2 零证据降级=带测试锚的刻意契约 | 宽松（测试可读出） | ✓ 计划增契约评估 | 确认 |
| F3 | T14 | MCP key=组织级只读、无 scope 模型 | ✓ | ✓ P0-7 设计重写 | 确认 |
| F4 | T15 | grantQuotaByEmail 同 reason 幂等+无钱包自动建 | 决策促成（合同语义） | ✓ 免建去重表 | 确认 |
| F5 | T17 | 影子一致性=key 集全等+Jaccard≥0.70+manual 剔除 | ✓ | ✓ M9 处置路径 | 确认 |
| F6 | T16 | lookup「漏报」lib/mcp/server.ts | ✗ 误报（search 含历史、lookup 当前快照） | ✗ | **撤回**（feedback #24） |
| F7 | T18 | 登录自动认领待处理邀请（隐藏业务副作用） | ✓ | ✓ 登录改造计划 | 确认 |
| F8 | 对照实验 | 答案键 stale——历史事实被当当前事实用 | ✓ | ✓ stale 门升最高位 | 确认 |
| F9 | 对照 T2 双臂 | asSpecScenario 硬编码 evidence=[]（离线判据退化） | ✓ 但**双臂互证，非 MCP 独占**（计入任务发现） | ✓ T2 修复方向 | 确认（修复未实施） |

**统计**：严格口径确认 **5** 条（F1/F3/F5/F7/F8）；宽松 1（F2）；撤回 1（F6）；双臂互证不归 MCP 独占 1（F9）；决策促成 6 条（F4 等）。**禁止再引用「独立发现 6/7」的旧口径。**

## 成本口径分层（禁止跨层汇总平均）

| 层 | 口径 | 数据 |
|---|---|---|
| 修复前 | MCP 附加响应成本 | tranche 1-2：≈270KB/10 任务 |
| 修复后 | MCP 附加响应成本 | T18：≈76KB/1 任务（search 60+lookup 8×2） |
| 对照 | Agent 全程 token（harness 报告，含推理；未拆 cache/输入/输出） | T1 1.06 vs 1.13M；T2 1.46 vs 2.70M |

## 试点协议修订记录

- **原协议（2026-11-18）**：tranche 1 五任务中期判定（差则终止）→ 累计 ≥20 真实任务出最终报告。
- **修订 1（2026-11-18，tranche 1 后）**：增加「A 层独立发现 ≥1 则继续」分支。
- **修订 2（2026-11-19，用户裁决）**：**决定性对照（干净上下文配对任务 ±MCP + 盲评）替代凑满 20 任务**。理由：n=2 配对+归因隔离的信息量大于继续堆任务数量。替代证据=决定性对照节。不再适用指标=20 任务累计计数、跨层平均净收益。
- **修订 3（2026-11-19，ChatGPT 反馈）**：判决措辞收紧至配对任务范围（见上）；后续验证方向=少量**不同类型**任务重复 + 跨仓库验证（SalesBuddy 账本为候选对象），不凑数。
- **修订 4（2026-11-19，本节追加）**：独立发现统一登记表（上表）与成本分层口径成为唯一有效统计面。

## 根治：增量重提取丢场景（release 280 案例的修复，2026-11-19）

**根因定位**（读码实锤）：`lib/spec-diff.ts` `preserveUnchangedEvidence` 的保真谓词是 `evidence.every(路径不在行为变更集)`——**一条场景只要有一条证据在被动过的文件里，整条就不保**，完全依赖重提取召回。radar 提交只改 `lib/ai.ts` +2 行，功能「AI 规格分析与发布变化」全部 ~20 条场景（证据横跨 ai.ts 与未改动的 analysis.ts/extraction-pass.ts 等）因 `every` 谓词全部失去 carry-forward 资格，重提取没吐回来就整批消失。全局坍缩护栏没响是因为其他 push 新增场景掩盖了局部坍缩（BM-7 单功能护栏只告警不拦截）。

**修复**（锚点级保真，三处）：
1. `lib/spec-diff.ts`：`preserveUnchangedEvidence` 升级为逐锚点判定——路径不在变更集→安全；在变更集但**旧行锚点不与任何 hunk 相交**→安全并确定性重映射行号（`parsePatchHunks` 解析 `@@ -o,c +n,d @@`，纯插入 oldCount=0=空区间不相交，锚点位移=Σ前段 hunk 增减）；锚点落入变更 hunk 或无行号→保守不保仍交 AI。无 hunk 信息时退回旧语义（全量兼容）。
2. `lib/analysis.ts` saveResult：从行为文件的 patch 组装 `changedHunksByPath` 透传。
3. `lib/spec-versions.ts` insertSpecVersion：options 增加透传。

**红线核验**：manual 保护不变（source!=='manual' 检查保留）；FUR=0 不受影响（本修复只恢复"行为未变的旧记录"，不折叠任何东西）；AI 重发的同引用场景优先、carried 副本不并列（既有去重保留）；无 hunk 数据=旧行为（回归兼容）。测试 6+1 用例（混证据锚点外→保+重映射 / 锚点入 hunk→不保 / 纯插入→保+位移 / 无行号→保守不保 / 无 hunks→旧语义 / manual 与 AI 重发去重 + 解析器）。typecheck/test/build 三绿。**未提交部署**——等 run 397 全量重建完成后部署（部署会重启容器，避免杀掉在途重建；孤儿恢复机制兜底但浪费一次跑）。

## 复活执行记录（2026-11-19，用户 go）

1. **run 397（全量重建）被坍缩护栏正确拒绝**：`spec_collapse_rejected: 1131→584`，事务回滚。结论：1131 条是数月增量积累，单次全量重提取天然只覆盖一半——**积累型账本的全量重建不是修复工具**（护栏防住了一次腰斩）。触发时临时翻转的 analyze_mode=full 已恢复 incremental（坑：manual+空 diff 撞 BM-10 零行为跳过；queued run 派发有 10 分钟积压阈值非故障）。
2. **根治修复已部署** sha-45df05a（release 281，对账 unexpected=[]）：`preserveUnchangedEvidence` 锚点级保真（hunk 相交判定+行号重映射+旧语义兼容）。
3. **确定性复活完成**（复用 `scripts/restore-collapsed-scenarios.ts` 的 planRestores 先例，容器内执行+HEAD 路径集注入）：dry-run 38 条候选全过证据存在性过滤 → apply 写入 4 个功能：**AI 规格分析与发布变化 +30（release 280 丢失的那批，基线 v290=release 279 版本）**、业务分组候选 +1、产品现状快照生成 +4、本地快照单页报告 +3；spec_file_index 已重建；快照表+工作台双表写入、行为等价门挡变体、引用冲突重编号（先例口径）。ai.ts 锚点 ±2 行漂移按先例不重映射（容差内）。
4. **读侧验证**：get_feature 30 条全部回归且证据锚定当前 HEAD；账本已把修复自身行为提取为新场景（EC-32~39/HP-23~26，证据 spec-diff.ts:643-732）——新旧场景引用重编号共存，账本比事故前更完整。

**试点档案最终状态**：stale 门=P0 产品项（写侧修复已落地，读侧标注待做）；修复链条完整——根因定位（读码）→ 修复（TDD）→ 部署 → 复活（确定性脚本）→ 验证（MCP 读侧）。

## Tranche 1 中期读数

| 指标 | 计数 | 备注 |
|---|---|---|
| 独立发现（严格口径） | **2** | ①radar/deploy 覆盖存在+红线清单（纠先验错）②EC-2 刻意契约（严格口径下测试可读出，宽松计入） |
| 决策促成 | **2** | ①设计文档 §15 修正+P0 对账锚点更换 ②T1 计划增加 EC-2 契约同步评估 |
| 重复确认 | 3 | 多仓库锚定 ×2、prompt 文件位置 |
| 无效打扰 | 1 类 | lookup 响应重复条目（系统性，应修） |
| 查询摩擦 | 3/6 空 | 语义召回对词形敏感 |
| MCP 附加成本（非净成本） | ≈150KB ≈40k token | 5 任务 planning 阶段；对 agent 是真实上下文成本 |

**停止规则判定**：A 层独立发现 ≥1 且决策促成 ≥1 → **不触发终止，继续 tranche 2**。初步结论方向：lookup_by_files（反查）在计划阶段有真实价值且可纠正错误先验；search_scenarios 语义召回是短板（词形敏感 + 历史噪声 + 响应膨胀待修）。
