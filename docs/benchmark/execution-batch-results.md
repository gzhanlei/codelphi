# Execution Batch 实测结果（双步 batch 基线 + fused 实验）

状态：**实验中**（本文件只记录实测值；所有指标来自 scratch 库 codelphi_bench 的真实 run，无估算）。

冻结协议：`docs/benchmark/execution-batch-v1.md`（20 分钟墙钟北极星、请求/Token/费用/墙钟四类独立、过程门禁失败直接 failed）。

## 0. 用户裁决（2026-11-22）

- **双步 batch 冻结为基线**：不再投入完整验证轮次（run 5 已证明请求合并价值，但墙钟未达标）。
- **Task 13 fused 单步立即实验**：batch size=4 / 并发=4，其余条件与 run 5 对齐；新增
  cost-per-accepted-task 与 time-per-accepted-task 指标 + P50/P95 单任务完成时间。
- **Task 12 并发档位**放在 fused 初步结果之后（避免混淆 fused 收益与并发收益）。
- 方向判断：从 Request Optimization 转向 Work Optimization——瓶颈是每任务的模型工作量与
  其可并行性，而非每批能塞多少任务。

## 1. run 5：双步 batch 基线（用户叫停于 43%）

- commit：b54d093（bench/task11），batch size=4 / 并发=4，模型配置与 fused 臂一致。
- 终态：**24 分钟**（含叫停收尾），处理 1,085/2,613 任务（43%）。
- **用户叫停原因**：并发修复后仍慢于 task 臂——20 分钟北极星验证未达标。

### 1.1 会计（四类独立）

| 指标 | 实测值 |
| --- | --- |
| 实际模型调用 | 674（batch 554 + repair 102 + 其他 18） |
| task 臂可组批调用基线 | ~5,200（≈ 2×2,613，历史 task 臂口径） |
| 请求降幅 | **≈ 87%**（674 vs ~5,200——远超 -60% 目标 ✓） |
| Token | 7,227,798 |
| 费用 | ¥1.26 |
| 墙钟 | 24 分钟（43% 处叫停）→ 完整跑完估 ~55 分钟 |

### 1.2 质量与修复分布

| 项 | 实测值 |
| --- | --- |
| extracted | 451（处理过的 1,085 任务中 42%） |
| no_behavior | 687（63%）—— 注意：未处理完，分布非终态 |
| unresolved（终态） | 90 |
| running（叫停在途） | 112 |
| repair 回执 | 102（102 个不同任务，无重复触发） |
| repair 后仍 unresolved | 80 → **repair 有效率 ~22%**（质量信号：batch judge 单成员结论质量偏低） |

### 1.3 请求合并价值已验证、墙钟价值未验证

- 请求合并 ✓：请求数 -88%，调度开销、网络往返、请求管理成本相应下降。
- 墙钟 ✗：batch 把 4 任务合进 1 次大调用，输出 token 总量不变（judge 输出 4 任务全量结论），
  单次大调用时长 ≈ 4× 单任务调用——纯模型时间没有省。
- 额外回路（已修复为公共设施，见 §3）：planner 串行预读、attempt 内 3× 重复源码加载、
  repair 回路（102 次完整单任务 judge = 请求份额回吐 15%）。
- 串行执行缺陷：batch 计划最初无并发池（第一轮 26 任务/分钟），修复后 38 任务/分钟。

## 2. 途中发现并修复的真库缺陷

| 缺陷 | 修复 |
| --- | --- |
| mysql2 对 JSON 列自动解析返回对象，plans/attempts 按"字符串再 parse"处理 → 首个 batch 臂 run 在 validateStoredPlanSet 崩溃 | parseJsonColumn 双形状兼容（7c99f5c）——fake execute 给字符串、真库给对象，两者都工作 |
| batch 计划无并发池（串行 for 循环执行 attempt） | 与 fallback 路径同款 worker pool（b54d093） |

## 3. 三回路修复（公共设施，不与 fused 绑定）

1. planner 预读并行化（2613 次串行源码读取 → 16 路并发池，0aff98b）。
2. attempt 源码快照一次加载、describe/judge/extraction 三处复用（a9987c9）——兼有正确性价值：
   避免三次读取之间源码漂移导致同一 attempt 各阶段基于不同输入。
3. repair 触发原因三类计数（format_or_parse / evidence_or_contract / model_capacity，
   0aff98b）——不把 repair 混为纯缺陷，也为质量守卫提供可见性。

## 4. 本地源码后端 + 三臂对照（2026-11-22）

用户裁决放弃 GitHub API 源码读取：`ANALYSIS_SOURCE_BACKEND=local_git` + `LOCAL_SOURCE_GIT_DIR`
从本地 clone 直读 tree/blob（`local-git-backend.ts`，SourceBackendKind="local_git" 已在设计中
预留），rate limit 归零、源码读取变本地磁盘。工作树直读优先（worktreeFallback），
sha 精确取值兜底。

### 4.1 run 10：task 臂 8 并发（本地源码）——57 分钟，门禁拒绝

| 项 | 实测值 |
| --- | --- |
| 墙钟 | **57 分钟**（8 并发反而慢于 4 并发的 20 分钟） |
| 终态 | extracted 777 / no_behavior 1,594 / unresolved 234 / **failed 51** |
| failed 根因 | 单任务 judge evidence cap(10)（zod too_big）——7c22739 只放宽了 batch 侧，task 侧漏改 |
| 调用/Token/费用 | 5,420 / 1,844 万 / ¥1.69（仅 2 条 unknown） |
| 附带发现 | 本地后端每 blob 一次 git cat-file 子进程，8 并发下 spawn 开销放大 |

### 4.2 修复（70e80f2）

1. task 臂 judge evidence cap 10→20（与 batch 同口径，7c22739 族收尾）。
2. 本地后端 `worktreeFallback`：优先直读 checkout 文件（零子进程），cat-file 兜底。

### 4.3 run 11：task 臂 4 并发修复版——53.8 分钟，门禁拒绝（外部事故）

| 项 | 实测值 |
| --- | --- |
| 墙钟 | 53.8 分钟 |
| 终态 | extracted 646 / no_behavior 1,078 / unresolved 231 / **failed 705** |
| failed 根因 | **AI 网关供应商故障**（deepseek http 402 余额不足；zhipu/kimi http 429）——非代码缺陷 |
| 调用/Token/费用 | 5,816（成功 3,698 + 失败 2,118）/ 1,220 万 / ¥0.96 |
| usage unknown | 2,118（全部为网关失败调用，unknown ≠ 0 纪律生效） |

中途检查（11/21/41 分钟）：failed=0——修复前 51 个 evidence cap 硬失败已消除，
**直到网关 402 开始时点前 run 11 是健康的**。

### 4.4 run 9：fused 臂（本地源码 + 单次调用）——22 分钟时 57% 被用户叫停

| 项 | 实测值（叫停点） |
| --- | --- |
| 墙钟 | 22 分钟 / 57%（1,513/2,656）→ 全量外推 ~38 分钟 |
| 调用 | 870（fused 每 attempt 1 次） |
| 质量 | extracted/no_behavior 分布与双步同量级，unresolved 占比正常 |

## 5. fused 臂全量终跑（run 12，网关充值后）

同 commit 线（09a71a9 代码 + 本地源码后端）、batch size=4 / 并发=4，与 run 5 双步基线对齐。

| 项 | 实测值 |
| --- | --- |
| 主循环 | 36 分钟至 91%（2,384/2,620）后 worker 退出，235 任务租约过期 |
| 自动恢复 | 两轮 `bench-resume`：235 → 31 → **0**（全部落终态），第三轮 gate 重评 |
| 终态质量 | extracted 884 / no_behavior 1,606 / unresolved **129** / failed 1（全部 2,620 任务终态） |
| 总账务 | 调用 2,567 / Token ~1,530 万 / **¥2.62**（含恢复轮重派的重调用） |
| 激活门禁 | **拒绝**：`anchorAccountingComplete`+`allUnitsInAllowedTerminalStates`——129 个 unresolved 锚点按 D5 fail closed |

**意外收获——恢复机制的真实全链实测**：235 个租约过期任务经由现有恢复协议
（响应已持久化的 attempt 零/低调用续拆、租约过期任务重新 claim）两轮收敛到全部
落终态。这正是 §16 恢复矩阵设计的落地证明。

## 6. 终版三臂对照（同一仓库同一 commit 线）

| 臂 | 墙钟 | 调用 | Token | 费用 | 质量（gate） |
| --- | --- | --- | --- | --- | --- |
| **task 4 并发**（run 1，GitHub 源码） | **20 分钟 ✓** | ~5,800 估 | — | — | **gate 通过、规格落库 ✓** |
| 双步 batch（run 5，43% 叫停） | 24 min → 外推 ~55 | 674@43% | 723 万@43% | ¥1.26@43% | — |
| **fused 单步**（run 12，本地源码） | **~46 分钟**（36 主循环+10 恢复） | 2,567 | 1,530 万 | ¥2.62 | **gate 拒**（129 unresolved） |
| task 8 并发（run 10，本地源码） | 57 分钟 | 5,420 | 1,844 万 | ¥1.69 | gate 拒（51 evidence-cap 硬失败，已修） |
| task 4 并发修复版（run 11） | 53.8 分钟 | 5,816 | 1,220 万 | ¥0.96 | gate 拒（网关供应商事故 705 failed，外部原因） |

**每验收任务成本**（cost per gate-accepted behavior）：task 臂是唯一 gate 通过的臂，
其成本口径为基准；fused ¥2.62 全花费未换来 gate 通过——**单位验收成本劣化**。

### 终局结论

1. **task 臂 4 并发 = 全面最优**：墙钟 20 分钟（fused 2.3 倍、双步 2.75 倍）、唯一通过
   activation gate。20 分钟北极星由 task 臂达成，无需 batch。
2. **冻结协议 §20.3 瓶颈重审条款两次触发验证**：请求 -88% 不省墙钟——模型时间 =
   输出 token 总量 ÷ 生成速率，与请求数无关。Request Optimization 路线到此证伪；
   Work Optimization（减少每任务输出 token 或提升生成吞吐）才是真杠杆，属后续课题。
3. **fused 的质量问题**：unresolved 129 个（4.9%）未达 gate 通过水位（task 臂同轮
   repair 语义消化后通过）——单次调用中模型自陈事实+判定并未提高判定质量，
   反而失去了双步里 describe 中间产物对 judge 的支撑。
4. **batch 基础设施的持久价值（保留）**：请求身份/回执幂等/原始响应持久化/
   **恢复矩阵真实生效**（235 任务两轮自动收敛）/repair 三身份。这是质量与可恢复性
   资产，未来任何执行架构都可复用。
5. **额外产出**：`local_git` 源码后端（bench/自托管零 rate limit）、task 侧 evidence
   cap 对齐、三处执行回路修复——均独立于实验结论存活。

## 7. run 13：修复版 task 臂复测（2026-11-22 追加）——结论修正

为回答「task 臂分析质量」做可审计复测（网关恢复后，70e80f2 修复版代码 + 本地源码 + 4 并发）：

| 项 | 实测值 |
| --- | --- |
| 墙钟 | **59 分钟**（run 1 的 3 倍——local-git `cat-file` 子进程 spawn 开销在 4 并发下也严重拖累） |
| 终态 | extracted 839 / no_behavior 1,581 / **unresolved 237** / failed 3 |
| 调用/Token/费用 | 5,110（全 success）/ 1,684 万 / ¥1.33 |
| **激活门禁** | **拒绝**：`anchorAccountingComplete`+`allUnitsInAllowedTerminalStates`（237 个 unresolved 锚点） |
| evidence cap | 修复后 failed 51→3，但 `too_big maximum:20` 仍出现——模型在密集区可输出超过任何固定上限 |

### 7.1 结论修正（重要）

1. **「task 臂 20 分钟 + gate 通过」不可复现**：run 1 是唯一绿观测。同代码重跑（run 13）
   gate 拒、墙钟 3 倍。全量分析的质量收敛在该仓库上天然处于 gate 边缘，unresolved 数量
   在 129（fused）～237（task）之间随模型输出波动——**不是执行架构的属性**。
2. **evidence cap 需要终极修复**：固定 max 值（10/20）都会被密集区打爆（3/51 次）。
   正确形态是**剥除超额 evidence 保留前 N 条并记诊断**（软上限），而非整任务硬失败。
3. **local-git 后端的 spawn 开销必须优化**（tree 列表批量导出 / worktree 直读升级为
   主路径 + revision 一致性校验），否则本地源码路线墙钟不可接受。
4. **各臂 unresolved 对照**：fused 129（4.9%）反而低于 task 237（9.0%）——合并调用
   没有降低判定质量；「fused 质量更差」的假设不成立。
5. 对用户问题「task 臂分析质量如何」的最终回答：**结构质量唯一一次过 gate，但不可
   复现；内容质量（召回/假阳性/证据支持）从未盲评**——这是本仓库全量分析的现状，
   与执行架构无关，属于 gate 边缘波动 + unresolved 语义复核收敛问题。

## 8. 内容质量初筛：生产规格 10 样本对照（2026-11-22 追加）

方法：从生产库 CoDelphi 最新激活规格随机抽 10 个场景（跨 10 个不同功能）作金标准，
在 run 13 task 臂的全部提取产物（2,657 任务 / 4,123 个提取场景）中做双判定对照：
① 证据路径命中（金标准证据文件被产物场景引用）② 语义关键词命中（≥2 个行为语义词）。

| 判定 | 数量 | 明细 |
| --- | --- | --- |
| **COVERED**（路径+语义双命中） | **3/10** | release-notes canPublish、execution-batch runner、behavior-inventory 清单生成 |
| PATH_ONLY（文件被引用 5–48 处，措辞未达关键词阈值） | 6/10 | analyze.ts、mcp/oauth.ts、spec-drift.ts、chandler-auth.ts、gitlab.ts、spec-editor-service.ts |
| MISS（路径零命中） | 1/10 | lib/billing/constants.ts |

**MISS 根因核实**：constants.ts 在 run 13 有 14 个任务覆盖（public_api+symbol_range 分片），
全部判 `no_behavior`——纯常量声明无外部可感知行为，是合理分类；生产规格的该场景从
消费方视角描述，行为本体在使用这些常量的调用方代码里。**分类口径差异，非漏提取**。

### 8.1 初筛结论与局限（如实）

- **行为面覆盖 90%（9/10 文件被审查）**：task 臂把金标准行为所在的代码区域基本都
  纳入了提取。
- **语义场景覆盖自动初筛 30%（3/10）**：但 6 个 PATH_ONLY 是两次独立模型运行的
  **措辞差异**所致（关键词阈值对中文措辞敏感）——需要人工语义复核才能定论，
  很可能大半实际已覆盖。这是初筛，不是盲评结论。
- 局限声明：①金标准（生产规格）是多次增量累积的最新态，task 臂是单 revision 全量，
  两者结构天然不同；②run 13 尚有 237 unresolved 未完成语义复核；③自动关键词判定
  无法替代双盲人工/模型评审。
- **「task 臂质量过关」的当前证据水位**：结构 gate 通过 1 次（不可复现）+ 行为面
  覆盖 90%（初筛）+ 语义覆盖 30%（自动初筛下限，人工复核待做）。

## 8.1 第二批 10 样本（补充抽样）与两批合计

第二批（同方法，含 context 字段参与语义判定）：

| 判定 | 数量 | 明细 |
| --- | --- | --- |
| COVERED | **7/10** | gitlabToken 回退、投影重建跳过、batch planner 确定性、0-grant 跳过、架构投影、LLM 分时定价、MCP token 400 |
| TERM_ONLY | 1/10 | features.display_name（语义命中 9 处——行为在应用代码被提取，证据路径口径是迁移文件，实际已覆盖） |
| PATH_ONLY | 1/10 | auth/login 400 invalid_input（9 处路径命中，措辞未达阈值） |
| MISS | 1/10 | **components/remove-product-button.tsx（前端 UI 组件，0/0）——行为清单检测器对前端组件存在盲区** |

### 两批合计（20 样本）

| 口径 | 覆盖率 | 说明 |
| --- | --- | --- |
| 严格双命中（路径+语义） | **10/20 = 50%** | 自动初筛下限 |
| 行为面覆盖（路径或语义任一命中） | **17/20 = 85%** | TERM_ONLY 的迁移文件口径差异算实际覆盖 |
| 真 MISS | **2/20 = 10%** | 纯常量文件（合理 no_behavior 口径差异）+ 前端 UI 组件（**检测器盲区，真缺陷**） |

### 修正后的质量结论

1. **语义覆盖 50%（双命中下限）优于第一批的 30%**——两批方差大（样本量小），合并看
   50% 是自动初筛下限；PATH_ONLY 7 个人工复核后大概率上修。
2. **发现一个真缺陷**：前端 UI 组件（remove-product-button.tsx）未被行为清单覆盖——
   detector 对前端组件的检测盲区，与执行架构无关，属 inventory 检测器待办。
3. 其余 19/20 行为面齐备；常量文件的 no_behavior 是合理口径。

## 8.2 第三批 10 样本与 30 样本汇总

第三批：COVERED 6/10（60%）——public-demo 缓存复用、通知渠道异常、Turnstile 半配置、
chandler 502 映射、MCP 批量通知 202、分析触发 sweep 全部双命中；TERM_ONLY 2
（**turnstile-widget.tsx 前端组件但语义命中 35 处**——行为经关联文件被提取）；
PATH_ONLY 1（pr-preview 静默返回）；MISS 1（product-navigation.tsx **0 任务——前端
组件检测盲区第二次确认**）。digest.ts 被 3 个任务覆盖但 buildDigest 场景未产出
（2 no_behavior + 1 unresolved 待复核）。

### 30 样本总汇总

| 口径 | 覆盖率 |
| --- | --- |
| 严格双命中（路径+语义） | **16/30 = 53%** |
| 行为面覆盖（任一命中） | **27/30 = 90%** |
| MISS | **3/30 = 10%**：纯常量口径差异 ×1 + **前端组件检测盲区 ×2（双重确认）** |

### 盲区定性（真缺陷，与执行架构无关）

`components/*` 的 UI 状态展示类组件（remove-product-button、product-navigation）
**未进入行为清单**（零任务），而 Turnstile widget 的行为能经关联文件被覆盖——
行为清单 detector 对「UI 状态展示类前端组件」存在稳定盲区。这是 inventory
检测器的待办（前端组件的单元检测/锚点策略），不影响本实验的执行架构结论。

## 10. 盲区修复验证（run 14，2026-11-22）：根因是配置不是 detector

30 样本对照后用户裁决转向盲区修复。根因核实：**bench 种子的 source_roots 漏了
components/（app/lib/scripts），前端组件从未进入分析范围**——inventory detector 本身
支持 .tsx（next 路由/page + generic symbol_range 分片）。修复：种子加 components
（c34e2b0）。

run 14（task 臂 + components 范围，45 分钟）：

| 项 | 实测值 |
| --- | --- |
| 任务总量 | 2,978（比 run 13 多 322 = 组件任务） |
| **组件任务** | **318 个，全部处理**：extracted 126（40%）/ no_behavior 103（32%）/ unresolved 89（28%） |
| **两个原 MISS 组件** | **remove-product-button、product-navigation 均已被提取** ✓ |
| 总终态 | extracted 958 / no_behavior 1,684 / unresolved 334 / failed 2 |
| 总账务 | 5,829 调用 / 1,927 万 token / ¥1.53 |
| 激活门禁 | 仍拒：unresolved 334 未收敛（组件判定贡献 89 个） |

**结论**：
1. 盲区根因 = **配置遗漏**，一行种子修复后前端组件完整入清单（318 任务、40% 提取出
   场景）——"detector 缺陷"假设不成立，撤回。
2. unresolved 总量随分析面扩大而增长（237→334）：gate 稳定通过的前提是 unresolved
   语义复核收敛，这是**质量收敛课题**（repair 轮次/复核策略），与执行架构和 detector
   均无关，属后续独立课题。

## 11. 待办

- [ ] 7 个 PATH_ONLY 样本的人工语义复核（判定真实语义覆盖率）
- [x] 前端组件盲区：根因=bench 种子 source_roots 漏 components（非 detector 缺陷）；修复 c34e2b0；run 14 验证 318 组件任务入库、两个原 MISS 组件被提取
- [ ] unresolved 语义复核收敛：334 个 unresolved 使 gate 无法通过（run 11/12/13/14 一致）——质量收敛课题（repair 轮次/复核策略），独立于执行架构
- [ ] evidence cap 终极修复：软上限剥除超额 evidence（非硬失败）
- [ ] local-git 后端 spawn 优化（批量 tree 导出/worktree 主路径化）
- [ ] 可复现性验证：GitHub API 源码 + 4 并发 + 修复版 task 臂重跑一轮（排除 local-git 变量）
- [ ] 冻结预标 34 条盲评（`docs/benchmark/frozen/codelphi-self-v1/`）——正式盲评结论
- [ ] 中间批次 release 对账（等 run 429 全量重析完成）
- [ ] 未获单独批准不启用生产 batch/fused
