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

## 5. 三臂结论与下一步

1. **task 臂（4 并发 + GitHub API 源码）仍是墙钟最优**：20 分钟全量。合并请求
   （batch/fused）在输出 token 总量不变的约束下无法超越它——冻结协议 §20.3 的
   瓶颈重审条款被两轮实验触发确认。
2. **8 并发劣于 4 并发**（57 vs 20 分钟）：子进程 spawn + 疑似服务端并发排队；
   Task 12 并发档位实验有真实价值但需在 task 臂上做，且 4 已是本环境合理档位。
3. **执行 batch 的持久价值**：请求身份/回执幂等/原始响应持久化/零调用恢复/
   repair 三身份——这套基础设施是质量与可恢复性资产，与墙钟无关，保留。
4. **当前阻塞**：模型网关三供应商全挂（deepseek 402 余额 / zhipu+kimi 429）。
   fused 臂完整全量对照与 run 11 的干净重跑均需网关恢复（用户侧充值/换模型）。
5. 恢复后执行：fused 臂全量重跑（commit 09a71a9+，4 并发）→ 与 task 臂 20 分钟
   基线对照出终版报告。

## 6. 待办

- [ ] 模型网关恢复后：fused 臂全量重跑 + 终版对照报告（含 cost/accepted-task、
      time/accepted-task、P50/P95）
- [ ] 中间批次 release 对账（等 run 429 全量重析完成）
- [ ] 未获单独批准不启用生产 batch/fused
