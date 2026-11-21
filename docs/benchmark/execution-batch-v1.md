# Execution Batch Benchmark 协议 v1（冻结）

日期：2026-11-22。状态：**冻结**（计划 Task 1 Step 4；由 spec §18/§20.3/§23.8 推导）。任何调整属于协议修订，必须在实验开始前完成；**不得在看到结果后调整阈值或口径**。

## 1. 目标与北极星

- **墙钟北极星**：同规模（~2,900 task）全量分析 **20 分钟挑战目标**（spec §20.3）。
- 项目目标：可组批请求相对真实可组批基线下降 ≥60%、单位有效完成成本不恶化、墙钟向北极星逼近；20 分钟仅为挑战目标。
- 全部性能目标服从正确性、账务与恢复硬门禁（spec §20.1/§20.2）；**过程门禁失败直接 failed，性能数字再好也不得通过**。

## 2. 对照设计与基线锚点

- 同一 commit、同一 manifest、同一模型配置、同一 task 集合，分别以 **task 模式**与 **batch 模式**在 scratch DB 独立成 run。
- **官方统计基线 = task 模式臂的实测画像**，由 `scripts/execution-batch-baseline.ts` 对该 run 产出 `artifacts/execution-batch/run-baseline.json`。
- 无历史 run 画像可比（原计划锚定的 run 已终止、数据未保留）；报告必须列出基线缺失项，缺失观测标 `unknown`/`unavailable`，不得反推或填造。
- 不以单次运行宣称稳定提升；重复次数与波动处理见 Task 12（总时长相对差异 >20% 加跑第三趟，不选择性删除离群值）。

## 3. 独立指标（四类分别报告，不互相折算）

| 指标 | 口径 |
| --- | --- |
| 请求 | 实际可组批 describe/judge 调用数（分母 = 实际可组批基础调用，不用 `2N` 替代真实基线） |
| Token | 输入/输出/缓存分开记录 known 汇总；unknown 计数单列，缺 receipt 不按零成本 |
| 费用 | 真实 receipt 汇总；usage unknown 按保守规则处理 |
| 墙钟 | run `started_at → finished_at`；另记 429/超时/截断/解析失败比例 |

## 4. 过程门禁（任一失败 → 整体 failed）

- manifest hash 不变；unit/anchor/fragment/task key 不变；primaryCoverage 与 anchorCoverage 完整。
- 证据 allowSet 不扩大；场景归属与局部身份正确；activation gate 完全复用；repair 未完成不得激活。
- `unresolved` 不得被批处理转换为 `no_behavior`。

## 5. 统计协议（冻结）

1. **基本单位 = 冻结人工 behavior**（不是生成的 task/region/scenario 数）；同一 behavior ID 在两条路径配对。
2. 逐仓使用 **95% Newcombe 配对差值区间（method 10）**；宏平均 = 逐仓简单平均；**禁止**把全部样本合并成一个大比例。
3. 分层：普通 / residual / 大 task 分别报告、分别执行门禁；每层样本 <30 为 **inconclusive**；达到 30 不等于功效充分。
4. 判定：LowerCI > -0.03 → 该仓非劣；UpperCI < -0.03 → inferior/failed；区间跨阈值 → **inconclusive，不得判通过**。
5. 宏平均误报上升 >0.03 或宏证据支持下降 >0.02 → failed；缺误报/证据会计 → inconclusive。
6. 结论三值 **pass / fail / inconclusive**；inconclusive（样本或统计证据不足）**不得视为通过**。
7. 盲评：两名不知路径来源的评审独立标注，分歧由第三名盲评裁决；标签冻结后才允许揭盲和比较。

## 6. 实现锚点

- 统计计算复用 `lib/behavior-benchmark.ts`（`evaluateBehaviorNonInferiority`、`NON_INFERIORITY_MARGIN=-0.03`、`MIN_PAIRED_BEHAVIOR_SAMPLES=30`、`newcombePairedInterval`）。
- 对照 harness = `scripts/execution-batch-benchmark.ts`（Task 11）；画像聚合 = `lib/execution-batch/baseline.ts`（纯函数，缺失观测 null + 原因）。
