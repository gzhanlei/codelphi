# Legacy GUARD 锚点实验 v1 · 验收结果

- 实验：`legacy-guard-anchor-v1`
- 冻结 revision：`2659429e588da466fcb712ba096531343aa75d08`（源码窗口 `lib/analysis.ts:1-616`、`lib/env.ts:1-127`）
- 模型/参数：`ds-flash`，`temperature=0, max_tokens=16000, stream=false`
- 执行时间：2026-11-23（12 次真实调用，A/B/C/D × 3，不重试、不挑样本，全部 `finishReason=stop`）
- 真值：`legacy-guard-anchor-truth-v1.json`，CB-18/CB-30 经独立 Ground Truth 评审（agent-5，2026-11-23，`independentlyReviewed=true`）
- 输出判定：独立输出评审（agent-6，2026-11-23，`judgments.json` + `output-review.md`），未用锚点文本自动判命中
- 判定器：`evaluateLegacyGuardExperiment`（Task 2 离线门禁），原始数据与 verdict 存 `.superpowers/sdd/2026-11-23-legacy-guard-anchor-experiment/`（git-ignored）

## 判定结果

**status = `failed`；`adoptionReady = false`。** 候选关闭，不扩大提取规则。

失败原因（判定器原文）：

| reason | 含义 |
| --- | --- |
| `d_false_positives_increase` | D 虚假行为 1 > A 的 0（D1「库存编排全量分析」EC-1 声称 partitions 保持空数组，与源码 else 分支装配矛盾） |
| `d_input_tokens_increase` | D 输入合计 39,504 > A 的 39,141 |
| `d_output_tokens_increase` | D 输出合计 8,807 > A 的 8,729 |
| `d_actual_cost_increase` | D 实际费用 $0.014705 > A 的 $0.014578 |

未触发 inconclusive：12 次 usage 完整、定价版本与缓存条件全部一致（`deepseek-flash-2026-11:peak` / `auto-context-cache;period=peak`）、真值与输出均经独立评审、4 臂 × 3 次齐备。质量门禁其余项通过：C 的 CB-18（3/3）> A（1/3）且 A 未饱和；B 非锚点/整体召回无回退；D 的 CB-18 ≥ C 且 > B；D 非锚点/整体召回无回退；falseDeltas 不增加；D 调用次数（3）≤ A（3）。

## 四臂实测明细（3 次合计 / 计数）

| 指标 | A（基线） | B（压缩） | C（锚点） | D（压缩+锚点） |
| --- | --- | --- | --- | --- |
| CB-18 命中 | 1/3（A1） | 2/3（B1、B2） | 3/3 | 3/3 |
| CB-30 / 非锚点命中 | 3 | 3 | 3 | 3 |
| 整体召回（overallHits） | 4（2,1,1） | 5（2,2,1） | 6（2,2,2） | 6（2,2,2） |
| 虚假行为（falsePositives） | 0 | 0 | 0 | **1**（D1） |
| 虚假 Delta（falseDeltas） | 0 | 0 | 0 | 0 |
| LLM 调用 | 3 | 3 | 3 | 3 |
| repair / retry | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| 输入 token | 39,141 | 39,000 | 39,645 | **39,504** |
| 输出 token | 8,729 | 9,889 | 8,809 | **8,807** |
| 缓存命中 token | 25,984 | 25,728 | 26,496 | 26,240 |
| 缓存条件 | `auto-context-cache;period=peak` | 同左 | 同左 | 同左 |
| 定价版本 | `deepseek-flash-2026-11:peak`（USD） | 同左 | 同左 | 同左 |
| 实际费用（USD） | 0.014578 | 0.016003 | 0.014674 | **0.014705** |
| 证据 allowSet 不变 | ✓（12/12） | — | — | — |
| manual 保护 | ✓（12/12） | — | — | — |

成本口径：每次恰好 1 次主调用，无 repair/重试；usage 取网关真实回执（`prompt_tokens` / `completion_tokens` / `prompt_cache_hit_tokens`）；费用按冻结定价快照 `input×miss + output + cache×hit`（每百万 token 单价随 run 快照于 `raw-runs.json`）。

## 结论

锚点臂把 CB-18 召回从 A 的 1/3 提升到 C/D 的 3/3（方向性信号，n=3 不具备统计意义），但采用候选 D 未满足预算内替换的硬约束：输入/输出 token 与实际费用均高于基线 A，并引入 1 个虚假行为。按实验设计「任一确定失败即关闭候选」，`adoptionReady=false`，不进入推广评审、不增加提取规则。后续若重试，需要能同时压住 token/费用与虚假行为的锚点或压缩方案，并以更大真值集重新验证。
