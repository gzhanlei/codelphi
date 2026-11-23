# 分析管线批处理改进配对实验协议（analysis-pipeline-improvement-v1）

日期：2026-11-23。状态：执行前冻结；本协议不授权启用 `ANALYSIS_BEHAVIOR_EXECUTION_MODE=batch` 或生产 `inventory`。

## 1. 对照与隔离

- `L`：生产 legacy，只运行一次，冻结 `runId + outputHash`；对照复用同一输出，不重跑。
- `I0`：基线代码快照的 inventory + task，先于任何 I1 输出运行并冻结。
- `I1`：候选代码快照的 inventory + batch + describe_judge，不得复用 I0 的规格或 AI 输出。
- 三路径使用相同目标 revision、模型配置、输出语言、预算、定价和缓存条件。每条路径的激活规格隔离。
- 沿用 `behavior-inventory-v1` 的冻结真值、配对规则和统计门禁，不改变既有协议。

## 2. 时序

1. 冻结人工真值、实验身份和目标 revision。
2. 运行 L/I0，保存输出、runId、回执和配置哈希。
3. 由不知道路径身份的评审确认真值命中与 I0 输出问题。
4. 在查看任何 I1 输出前，冻结目标案例和错误分类。
5. 运行 I1；运行前补齐并冻结 candidateCodeSha 与候选 Prompt hash。
6. 完成 I1 匿名盲评和离线门禁。不得重跑 L/I0 替换不利结果。

目标错误分类：`fact_omission`、`fact_extraction_error`、`fact_interpretation_error`、`behavior_omission`、`evidence_mismatch`。至少一个案例检查严格 `>` 不得写成 `>=`。

## 3. Prompt 与执行身份

- describe 模板 hash 必须一致。
- judge 和 semantic repair 去除新增事实段后的基线模板 hash 必须一致；本轮不增加静态事实段。
- I1 只改变单任务双步为批处理双步，不启用 fused，不改变模型、输出语言、预算、定价和缓存条件。
- 每仓记录 baseline/candidate code SHA、runId、plan、taskKey 集、输出 hash 和每 task/stage 回执。

## 4. 质量与碎片化门禁

- 冻结行为召回不得下降。
- 误报率上升不超过 3 个百分点，证据有效率下降不超过 2 个百分点。
- 严格比较运算符的事实解释错误不得增加。
- 功能数不超过 I0 的 1.05 倍，场景数不超过 I0 的 1.10 倍，重复功能簇不得增加。
- 激活失败只保留实验结果，`adoptionReady=false`，不得切换生产模式。

## 5. 成本门禁

- 每仓 I1 总 LLM 调用数不超过 I0 的 35%。
- 每仓 `I1.totalTokens <= I0.totalTokens * 0.60`。
- 同币种、同定价、可比缓存条件下，每仓 `I1.costAmount <= I0.costAmount * 0.60`。
- 每个匹配 taskKey 的 total、describe、judge、semantic_repair 均不得增加；taskKey 集合必须一致。成功恢复任务新增调用必须为零。
- 耗时、重复功能簇和事实解释错误单独报告，不合并成综合分。

## 6. 判定与退出码

- 输入非法：exit 3。
- 确定的质量、召回、碎片化、成本或逐任务调用越界：failed，exit 1。
- 缺回执、实验身份不一致、币种/定价/缓存不可比、task 集不可匹配或质量统计 inconclusive：inconclusive，exit 2。
- 同时存在确定越界与不可比项时 failed 优先。
- passed，exit 0。passed 只代表实验门禁通过；`adoptionReady` 还取决于候选激活门禁和用户独立批准。

## 7. 实验描述文件

每仓一个 `analysis-pipeline-experiment-v1` JSON，字段由同目录 schema 定义。comparison、usage 和 output facts 路径相对 descriptor 所在目录解析。`baselineComparison` 的 inventory 是 I0，`candidateComparison` 的 inventory 是 I1，两者 legacy 必须指向同一 `legacyResult.outputHash`。

output facts 必填：`featureCount`、`scenarioCount`、`duplicateClusters`、`factInterpretationErrors`、`activationPassed`。缺字段或不可比输入不得放行。

usage 导出仅允许 scratch 数据库。导出器拒绝非 `codelphi_bench`、非 `codelphi_bench_*` 且不以 `_bench` 结尾的数据库；离线测量器不连接数据库、不调用 AI、不修改运行模式。
