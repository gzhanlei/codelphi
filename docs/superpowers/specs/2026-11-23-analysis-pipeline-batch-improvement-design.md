# 分析管线批处理改进设计

日期：2026-11-23
状态：设计已确认，待实施计划评审

## 1. 目标与边界

本轮只验证一个执行变量：在保持 inventory 的 manifest、unit / anchor / fragment / task 身份、证据 allowSet、独立结果提交和激活门禁不变的前提下，将单任务双步执行改为 execution-batch 双步执行。

目标依次为：

1. 显著降低模型调用数、token 和实际成本；
2. 不增加功能与场景碎片化；
3. 不降低行为召回、证据支持和事实解释准确性。

非目标：

- 不开发 USIR、通用静态分析平台、符号执行或形式化验证。
- 不在本轮增加静态分支/数值事实层，不向 Prompt 注入新事实段。
- 不启用 fused 单步，不改变 describe/judge 双步协议。
- 不改变生产默认 `task` 模式，不做生产部署或历史规格改写。
- 不以提升召回为验收前提；自仓 I0 已覆盖全部有效冻结行为。

## 2. 实测基线与问题

同一目标 revision `2659429e588da466fcb712ba096531343aa75d08`、独立 scratch 库：

| 指标 | L（legacy） | I0（inventory + task） |
| --- | ---: | ---: |
| 功能数 | 92 | 1320 |
| 场景数 | 1219 | 6016 |
| 冻结行为命中 | 32/34 | 34/34 |
| LLM 调用 | 148 | 7237 |
| 总 token | 1,268,333 | 18,653,105 |
| 实际成本 | USD 0.276366 | USD 2.016653 |

I0 因 `anchorAccountingComplete` 和 `allUnitsInAllowedTerminalStates` 未通过而未激活。自仓没有可供 I1 修复的有效漏报，因此原“至少修复一个 I0 漏报”目标取消。CB-34 的原真值描述与实现不符，不作为漏报目标。

当前主要问题是成本、功能碎片化和激活失败，而不是召回不足。既有 execution-batch 已接入 `full-analysis`，支持确定性 plan set、逐 task claim、原始响应持久化、独立提交与恢复，无需先建设新执行框架。

## 3. 方案选择

采用 **批处理优先**：

```text
I0 = inventory + task + describe_judge（已冻结）
I1 = inventory + batch + describe_judge（候选）
```

静态事实优先和“批处理 + 静态事实同时推进”均不在本轮。只有事实解释错误成为主要残差时，才另立静态事实实验。

## 4. 执行架构

沿用现有执行链：

```text
现有 Manifest + Task Planner
  → 确定性 batch plan set
  → 逐 task claim + 冻结 attempt member
  → batch describe / judge
  → 原始响应完整持久化
  → 按 task 切片、证据清洗、状态推导、独立条件提交
  → 现有聚合与 activation gate
```

I1 在独立 scratch 库运行：

```bash
FULL_ANALYSIS_MODE=inventory
ANALYSIS_BEHAVIOR_EXECUTION_MODE=batch
ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE=describe_judge
ANALYSIS_BEHAVIOR_CONCURRENCY=16
```

L/I0 的冻结输出不得重跑替换。I1 不得继承 I0 的规格或 AI 结果。恢复只能复用本 run 已持久化任务/响应，不得复用 I0 结果。

## 5. 实验身份与证据

每仓保留：

- 目标 before/after revision；
- 真值 frozenAt/version；
- L/I0/I1 runId、代码 SHA、输出 hash；
- 模型、模型配置、输出语言、预算、定价、缓存条件；
- describe/judge/repair 基线 Prompt hash；
- task/batch plan 与 taskKey 集；
- 每 task/stage 回执、成功恢复调用数、成本和耗时。

L 只运行一次并复用同一输出。任何缺失或不可比的身份字段判 inconclusive，不得放行。

## 6. 验收门禁

### 6.1 准确性

- 冻结行为召回不得下降。
- 误报率上升不超过 3 个百分点，证据有效率下降不超过 2 个百分点。
- 严格比较运算符（包括 `>` 与 `>=`）的事实解释错误不得增加。
- 事实错误分类：`fact_omission`、`fact_extraction_error`、`fact_interpretation_error`、`behavior_omission`、`evidence_mismatch`。
- 生产采用前必须通过全部激活门禁；未通过时只保留实验结果，不切换模式。

### 6.2 碎片化

- 功能数不超过 I0 的 1.05 倍。
- 场景数不超过 I0 的 1.10 倍。
- 重复功能簇不得增加；拆分/合并情况单独报告。

### 6.3 成本

- LLM 总调用数不超过 I0 的 35%。
- 总 token 不超过 I0 的 60%。
- 同币种、同定价、可比缓存条件下，实际成本不超过 I0 的 60%。
- 任一匹配 task 的 total / describe / judge / semantic_repair 调用不得增加。
- 成功恢复任务的新增调用必须为零。

### 6.4 判定

- 确定的质量、碎片化或成本越界为 failed。
- 缺回执、实验身份不一致、定价/缓存不可比或统计 inconclusive 为 inconclusive。
- failed 优先于 inconclusive。质量更好但越界的结果仍交用户决定，不自动采用。

## 7. 实施任务

1. **实验与门禁收口**：提交已有实验身份、usage 聚合、离线测量器及本设计对应验收规则。
2. **I1 运行与缺陷修复**：运行 batch I1；只对实际发现的缺陷按 TDD 修复，不预先扩大实现范围。
3. **验收与建议**：完成匿名盲评、成本/碎片化比较和文档，提交是否继续灰度的建议，不自动部署。

## 8. 回归红线

- 人工规格与人工裁决不得被覆盖。
- 证据 allowSet 不得扩大，unresolved/failed 不得伪装成 no_behavior。
- 覆盖与激活门禁不得放松。
- plan、attempt、原始响应和 task 提交不得互相冒充真源。
- 不得通过减少实现面、跳过未识别代码或扩大 residual 区间换取成本下降。
- 默认继续使用 `legacy` 与 inventory `task` 模式，未经用户单独批准不得启用 batch。
